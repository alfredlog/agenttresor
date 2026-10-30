/**
 * Spend-control proxy HTTP API.
 *   Agents (Authorization: Bearer agt_…): /v1/pay, /v1/requests/:id, /v1/requests/:id/execute,
 *     /v1/requests/:id/sign, /v1/budget, /v1/vault/agent-key
 *   Admin  (Authorization: Bearer ADMIN_TOKEN): /admin/… (agents, rules, approvals, ledger, vaults)
 *   Dashboard: / (public/index.html); vault funding page: /vault.html
 * Keys and tokens are never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import { getNetwork, txLink, type BsvNetwork } from '../shared/network.js'
import { agentKeyHint, generateAgentKey, hashAgentKey, isAgentKey, maskAgentKey } from './keys.js'
import type { ChainTracker, PrivateKey } from '../shared/bsv.js'
import type { Broadcaster } from '../vault/broadcaster.js'
import { PolicyKeys } from '../vault/keys.js'
import { VaultService } from '../vault/service.js'
import { VaultStore } from '../vault/store.js'
import type { Notifier } from './notifier.js'
import { DEFAULT_RULES, parseRules } from './rules.js'
import { ProxyError, SpendControl, type Outcome } from './service.js'
import { ProxyStore, REQUEST_STATUSES, SPENT_STATUSES, type Agent, type PaymentRequestRecord, type RequestStatus } from './store.js'

export interface ProxyAppOptions {
  db: Knex
  /** PROXY_ROOT_KEY: derives the policy key of every vault and the proxy's identity (BRC-29 sender). */
  policyRootKey: PrivateKey
  /** Verifies vault funding transactions (SPV). */
  chainTracker: ChainTracker
  /** Broadcasts signed vault payments. */
  broadcaster: Broadcaster
  notifier: Notifier
  adminToken: string
  now?: () => number
  network?: BsvNetwork
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url))
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString()

function requestView (r: PaymentRequestRecord): Record<string, unknown> {
  return {
    requestId: r.id,
    status: r.status,
    url: r.url,
    method: r.method,
    body: r.body ?? undefined,
    purpose: r.purpose,
    satoshis: r.priceSats,
    reason: r.reason,
    txid: r.txid,
    response: r.response ?? undefined,
    createdAt: iso(r.createdAt),
    decidedAt: iso(r.decidedAt),
    decidedBy: r.decidedBy,
    paidAt: iso(r.paidAt)
  }
}

/** The agent-facing answer for a request record. */
function outcomeBody (o: Extract<Outcome, { kind: 'record' }>): Record<string, unknown> {
  const r = o.record
  switch (r.status) {
    case 'paid': return { status: 'paid', requestId: r.id, txid: r.txid, satoshis: r.priceSats, response: r.response }
    case 'pending': return { status: 'pending', requestId: r.id, satoshis: r.priceSats }
    case 'paid_not_delivered': return { status: r.status, requestId: r.id, txid: r.txid, satoshis: r.priceSats, reason: r.reason, response: r.response ?? undefined }
    default: return { status: r.status, requestId: r.id, reason: r.reason }
  }
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

function bearer (req: Request): string | undefined {
  const m = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')
  return m?.[1]
}

/** Validates the body of POST /v1/pay; returns an error message or the input. */
function parsePayInput (body: unknown): { url: string, method: string, body?: unknown, purpose: string } | string {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.url !== 'string') return 'url is required'
  let url: URL
  try { url = new URL(b.url) } catch { return 'url is not a valid URL' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must be http(s)'
  if (url.username !== '' || url.password !== '') return 'url must not contain credentials'
  const method = b.method === undefined ? 'GET' : String(b.method).toUpperCase()
  if (!METHODS.includes(method)) return `method must be one of ${METHODS.join(', ')}`
  if (method === 'GET' && b.body !== undefined) return 'a GET request cannot have a body'
  if (typeof b.purpose !== 'string' || b.purpose.trim() === '') return 'purpose is required'
  if (b.purpose.length > 500) return 'purpose is limited to 500 characters'
  return { url: url.href, method, body: b.body, purpose: b.purpose.trim() }
}

export function createProxyApp (opts: ProxyAppOptions): Express {
  if (opts.adminToken.length < 16) throw new Error('adminToken must be at least 16 characters')
  const adminTokenHash = sha256(opts.adminToken)
  const network = opts.network ?? getNetwork()
  const now = opts.now ?? Date.now
  const store = new ProxyStore(opts.db)
  const vault = new VaultService({
    store: new VaultStore(opts.db),
    policy: new PolicyKeys(opts.policyRootKey),
    chainTracker: opts.chainTracker,
    broadcaster: opts.broadcaster,
    now
  })
  const control = new SpendControl({ store, vault, notifier: opts.notifier, now })

  const app = express()
  app.disable('x-powered-by')
  app.use(express.static(PUBLIC_DIR))
  // Funding BEEFs carry the transaction's unconfirmed ancestry, so allow more than a plain request needs.
  app.use(express.json({ limit: '2mb' }))

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next) }

  const requireAgent = (req: Request, res: Response, next: NextFunction): void => {
    const unauthorized = (): void => { res.status(401).json({ error: 'missing or invalid agent key' }) }
    const key = bearer(req)
    if (key === undefined || !isAgentKey(key)) { unauthorized(); return }
    store.findAgentByKeyHash(hashAgentKey(key)).then(agent => {
      if (agent === undefined) { unauthorized(); return }
      res.locals.agent = agent
      next()
    }, next)
  }
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const token = bearer(req)
    // Compare fixed-length hashes so timingSafeEqual never sees different lengths.
    if (token === undefined || !timingSafeEqual(sha256(token), adminTokenHash)) { res.status(401).json({ error: 'missing or invalid admin token' }); return }
    next()
  }
  const agentOf = (res: Response): Agent => res.locals.agent as Agent

  const sendOutcome = (res: Response, o: Outcome): void => {
    if (o.kind === 'free') { res.status(200).json({ status: 'free', satoshis: 0, response: o.answer }); return }
    if (o.kind === 'sign') { res.status(200).json({ status: 'sign', requestId: o.record.id, ...o.sign }); return }
    res.status(o.httpStatus).json(outcomeBody(o))
  }

  // ── Agent API ──────────────────────────────────────────────────────────────
  app.post('/v1/pay', requireAgent, wrap(async (req, res) => {
    const input = parsePayInput(req.body)
    if (typeof input === 'string') { res.status(400).json({ error: input }); return }
    sendOutcome(res, await control.requestPayment(agentOf(res), input))
  }))

  app.get('/v1/requests/:id', requireAgent, wrap(async (req, res) => {
    res.json(requestView(await control.getOwnRequest(agentOf(res), String(req.params.id))))
  }))

  app.post('/v1/requests/:id/execute', requireAgent, wrap(async (req, res) => {
    sendOutcome(res, await control.execute(agentOf(res), String(req.params.id)))
  }))

  app.post('/v1/requests/:id/sign', requireAgent, wrap(async (req, res) => {
    const { signature } = (req.body ?? {}) as Record<string, unknown>
    sendOutcome(res, await control.sign(agentOf(res), String(req.params.id), signature))
  }))

  app.get('/v1/budget', requireAgent, wrap(async (_req, res) => {
    res.json(await control.budget(agentOf(res)))
  }))

  // The agent generates its own key pair and registers only the public key.
  app.post('/v1/vault/agent-key', requireAgent, wrap(async (req, res) => {
    const { publicKey } = (req.body ?? {}) as Record<string, unknown>
    const v = await vault.registerAgentKey(agentOf(res).id, publicKey)
    res.json({ agentId: v.agentId, agentPub: v.agentPub, status: v.status })
  }))

  // ── Admin API ──────────────────────────────────────────────────────────────
  const admin = express.Router()
  admin.use(requireAdmin)

  admin.post('/agents', wrap(async (req, res) => {
    const { name, rules: rulesInput } = (req.body ?? {}) as Record<string, unknown>
    if (typeof name !== 'string' || name.trim() === '' || name.length > 100) { res.status(400).json({ error: 'name is required (max 100 characters)' }); return }
    const rules = rulesInput === undefined ? DEFAULT_RULES : parseRules(rulesInput)
    if (typeof rules === 'string') { res.status(400).json({ error: rules }); return }
    const apiKey = generateAgentKey()
    const agent: Agent = { id: `A-${randomBytes(4).toString('hex').toUpperCase()}`, name: name.trim(), keyHint: agentKeyHint(apiKey), createdAt: now() }
    await store.createAgent(agent, hashAgentKey(apiKey), rules)
    // The only time the key is ever returned.
    res.status(201).json({ id: agent.id, name: agent.name, apiKey, key: maskAgentKey(agent.keyHint), rules })
  }))

  admin.get('/agents', wrap(async (_req, res) => {
    const agents = await store.listAgents()
    res.json({
      agents: await Promise.all(agents.map(async a => ({
        id: a.id, name: a.name, key: maskAgentKey(a.keyHint), createdAt: iso(a.createdAt), rules: await store.getRules(a.id)
      })))
    })
  }))

  admin.put('/agents/:id/rules', wrap(async (req, res) => {
    const agent = await store.getAgent(String(req.params.id))
    if (agent === undefined) { res.status(404).json({ error: 'agent not found' }); return }
    const rules = parseRules(req.body)
    if (typeof rules === 'string') { res.status(400).json({ error: rules }); return }
    await store.setRules(agent.id, rules)
    res.json({ id: agent.id, rules })
  }))

  admin.get('/requests', wrap(async (req, res) => {
    const status = req.query.status
    if (status !== undefined && !REQUEST_STATUSES.includes(status as RequestStatus)) {
      res.status(400).json({ error: `status must be one of ${REQUEST_STATUSES.join(', ')}` }); return
    }
    await control.expireStale()
    const rows = await store.listRequests(status === undefined ? {} : { status: [status as RequestStatus] })
    res.json({ requests: rows.map(r => ({ ...requestView(r), agentId: r.agentId, agentName: r.agentName })) })
  }))

  // Approval = funding: the body is the company's request-vault funding transaction.
  admin.get('/requests/:id/approval', wrap(async (req, res) => {
    res.json(await control.approvalInfo(String(req.params.id)))
  }))

  admin.post('/requests/:id/approve', wrap(async (req, res) => {
    const funding = (req.body ?? {}) as Record<string, unknown>
    res.json(requestView(await control.approve(String(req.params.id), 'company', funding)))
  }))

  admin.post('/requests/:id/deny', wrap(async (req, res) => {
    const { reason } = (req.body ?? {}) as Record<string, unknown>
    const text = typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, 500) : 'denied by admin'
    res.json(requestView(await control.deny(String(req.params.id), 'admin', text)))
  }))

  admin.get('/ledger', wrap(async (_req, res) => {
    const rows = await store.listRequests({ status: SPENT_STATUSES })
    res.json({
      network,
      totalSats: rows.reduce((s, r) => s + (r.priceSats ?? 0), 0),
      entries: rows.map(r => ({
        ...requestView(r),
        response: undefined,
        agentId: r.agentId,
        agentName: r.agentName,
        explorerUrl: r.txid === null ? null : txLink(r.txid, network)
      }))
    })
  }))

  // ── Vaults (the company funds and reclaims them from its own wallet) ─────
  const knownAgent = async (id: string): Promise<string> => {
    if (await store.getAgent(id) === undefined) throw new ProxyError(404, 'agent not found')
    return id
  }

  admin.get('/vaults', wrap(async (_req, res) => {
    const vaults = await vault.listVaults()
    res.json({
      network,
      vaults: vaults.map(v => ({
        agentId: v.agentId,
        agentName: v.agentName,
        status: v.status,
        satoshis: v.status === 'open' ? v.satoshis : 0,
        outpoint: v.status === 'open' ? `${v.txid!}.${v.vout!}` : null,
        explorerUrl: v.txid === null ? null : txLink(v.txid, network)
      }))
    })
  }))

  admin.get('/vaults/:agentId/params', wrap(async (req, res) => {
    res.json(await vault.params(await knownAgent(String(req.params.agentId))))
  }))

  admin.post('/vaults/:agentId/funded', wrap(async (req, res) => {
    const v = await vault.acceptFunding(await knownAgent(String(req.params.agentId)), (req.body ?? {}) as Record<string, unknown>)
    res.json({ agentId: v.agentId, status: v.status, outpoint: `${v.txid!}.${v.vout!}`, satoshis: v.satoshis, explorerUrl: txLink(v.txid!, network) })
  }))

  admin.get('/vaults/:agentId/utxo', wrap(async (req, res) => {
    res.json(await vault.utxo(await knownAgent(String(req.params.agentId))))
  }))

  admin.post('/vaults/:agentId/reclaimed', wrap(async (req, res) => {
    const { txid } = (req.body ?? {}) as Record<string, unknown>
    const v = await vault.markReclaimed(await knownAgent(String(req.params.agentId)), txid)
    res.json({ agentId: v.agentId, status: v.status, explorerUrl: txLink(String(txid), network) })
  }))

  // ── Request vaults (one per approved payment; reclaimable if not spent) ──
  admin.get('/request-vaults', wrap(async (req, res) => {
    const status = req.query.status
    if (status !== undefined && !['open', 'spent', 'reclaimed'].includes(String(status))) {
      res.status(400).json({ error: 'status must be open, spent or reclaimed' }); return
    }
    await control.expireStale()
    const list = await vault.listRequestVaults(status as 'open' | 'spent' | 'reclaimed' | undefined)
    res.json({
      network,
      requestVaults: list.map(v => ({
        requestId: v.requestId,
        agentId: v.agentId,
        agentName: v.agentName,
        purpose: v.purpose,
        url: v.url,
        priceSats: v.priceSats,
        satoshis: v.satoshis,
        status: v.status,
        requestStatus: v.requestStatus,
        // An open vault whose request can no longer be paid is waiting to be reclaimed.
        reclaimable: v.status === 'open' && v.requestStatus !== 'approved',
        outpoint: `${v.txid}.${v.vout}`,
        explorerUrl: txLink(v.closingTxid ?? v.txid, network)
      }))
    })
  }))

  admin.get('/request-vaults/:requestId/utxo', wrap(async (req, res) => {
    res.json(await vault.requestVaultUtxo(String(req.params.requestId)))
  }))

  admin.post('/request-vaults/:requestId/reclaimed', wrap(async (req, res) => {
    const { txid } = (req.body ?? {}) as Record<string, unknown>
    const rv = await control.requestVaultReclaimed(String(req.params.requestId), txid)
    res.json({ requestId: rv.requestId, status: rv.status, explorerUrl: txLink(String(txid), network) })
  }))

  app.use('/admin', admin)

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ProxyError) { res.status(err.httpStatus).json({ ...err.details, error: err.message }); return }
    const status = (err as { status?: number }).status
    if (status === 400 || status === 413) { res.status(status).json({ error: 'invalid request body' }); return }
    console.error('proxy error:', err instanceof Error ? err.message : String(err))
    res.status(500).json({ error: 'internal error' })
  })

  return app
}
