/**
 * Spend-control proxy HTTP API.
 *   Agents (Authorization: Bearer agt_…): /v1/pay, /v1/requests/:id, /v1/requests/:id/execute,
 *     /v1/requests/:id/sign, /v1/budget, /v1/services, /v1/vault/agent-key
 *   Onboarding (no auth, one-time code, rate-limited): POST /v1/connect; page /connect#AT-…
 *   Admin  (Authorization: Bearer ADMIN_TOKEN): /admin/… (agents, rules, approvals, ledger, vaults, audit log, notary)
 *   Dashboard: / (public/index.html); vault funding page: /vault.html
 * Keys and tokens are never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import { getNetwork, txLink, type BsvNetwork } from '../shared/network.js'
import { agentKeyHint, generateAgentKey, hashAgentKey, isAgentKey, maskAgentKey } from './keys.js'
import type { ChainTracker, PrivateKey, WalletInterface } from '../shared/bsv.js'
import type { Broadcaster } from '../vault/broadcaster.js'
import { PolicyKeys } from '../vault/keys.js'
import { DEFAULT_COVENANT_MAX_FEE_SATS, parseCovenantScript, type CovenantCaps } from '../vault/covenant.js'
import { VaultService } from '../vault/service.js'
import { VaultStore } from '../vault/store.js'
import { AuditLog } from '../audit/log.js'
import { recordAnchor } from '../audit/anchors.js'
import { alertMessage, Notary, type NotaryConfig } from '../audit/notary.js'
import type { Notifier } from './notifier.js'
import { covenantMaxSats, DEFAULT_RULES, isEur, parseRules, RATE_UNAVAILABLE, type Rules } from './rules.js'
import { freshQuote, type RateProvider } from '../shared/rate.js'
import { CONNECT_CODE_TTL_MS, findConnectCode, generateConnectCode, hashConnectCode, merchantsFor, normalizeConnectCode, RateLimiter } from './connect.js'
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
  /** The proxy's public URL (PROXY_PUBLIC_URL), for connection links; default: the request's own origin. */
  publicUrl?: string
  /** Behind a reverse proxy (TRUST_PROXY=1): take the client IP from X-Forwarded-For, for the rate limit. */
  trustProxy?: boolean
  /** Attempts at POST /v1/connect per IP (default 10 per 10 minutes). */
  connectRateLimit?: { max: number, windowMs: number }
  /** Put an anchor of the audit log head into every vault payment (option A, default true). */
  anchorPayments?: boolean
  /** VAULT_COVENANT: NEW agent vaults are v2, capped on chain at the agent's maxPerPaymentSats (EUR rules: the euro maximum at the funding-time rate x 1.5; default false). */
  vaultCovenant?: boolean
  /** VAULT_COVENANT_MAX_FEE_SATS: the most fee a v2 payment may pay (default 1000). */
  vaultCovenantMaxFeeSats?: number
  /** The BSV/EUR rate (CoinGecko in the server): needed by EUR rules; without it, EUR payments are denied. */
  rates?: RateProvider
  /** Operational log lines (no secrets). */
  log?: (msg: string) => void
  /** The operator's notary wallet (option B): anchors the log when it is idle. Without it there is no idle anchoring. */
  notary?: { wallet: WalletInterface, identityKey: string, config?: Partial<NotaryConfig>, log?: (msg: string) => void }
  /** Why there is no notary, shown on the dashboard (e.g. NOTARY_ROOT_KEY is not set). */
  notaryDisabledReason?: string
}

/** The notary of an app made by createProxyApp, if it has one (the server starts its scheduler). */
export function notaryOf (app: Express): Notary | undefined {
  return app.locals.notary as Notary | undefined
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url))
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString()
/** The on-chain caps of a v2 vault, or null for a v1 (or not yet funded) vault. */
function covenantOf (lockingScript: string | null): CovenantCaps | null {
  const v2 = lockingScript === null ? undefined : parseCovenantScript(lockingScript)
  return v2 === undefined ? null : { maxSats: v2.maxSats, maxFeeSats: v2.maxFeeSats }
}

/** The euro limit a vault's on-chain ceiling stands for (EUR rules), shown next to it on the vault page. */
const policyOf = (rules: Rules): { currency: 'EUR', maxPerPaymentCents: number } | null =>
  isEur(rules) ? { currency: 'EUR', maxPerPaymentCents: rules.maxPerPaymentCents } : null

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
    paidAt: iso(r.paidAt),
    // The price in euros at the rate the request was judged (or paid) at.
    eurCents: r.eurCents ?? undefined,
    eurRate: r.eurRate ?? undefined,
    rateSource: r.rateSource ?? undefined,
    rateAt: iso(r.rateAt) ?? undefined
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
  const audit = new AuditLog(opts.db, now)
  const vaultStore = new VaultStore(opts.db)
  const vault = new VaultService({
    store: vaultStore,
    policy: new PolicyKeys(opts.policyRootKey),
    chainTracker: opts.chainTracker,
    broadcaster: opts.broadcaster,
    audit,
    now,
    anchorPayments: opts.anchorPayments ?? true,
    covenantCaps: opts.vaultCovenant === true
      ? async agentId => {
        const maxSats = covenantMaxSats(await store.getRules(agentId), { quote: await opts.rates?.current(), now: now() })
        if (maxSats === undefined) throw new ProxyError(503, `${RATE_UNAVAILABLE}: a v2 vault under EUR rules needs the current BSV/EUR rate to set its on-chain ceiling`)
        return { maxSats, maxFeeSats: opts.vaultCovenantMaxFeeSats ?? DEFAULT_COVENANT_MAX_FEE_SATS }
      }
      : undefined,
    log: opts.log
  })
  const control = new SpendControl({ store, vault, audit, notifier: opts.notifier, now, rates: opts.rates })
  const notary = opts.notary === undefined
    ? undefined
    : new Notary({
      wallet: opts.notary.wallet,
      identityKey: opts.notary.identityKey,
      audit,
      chainTracker: opts.chainTracker,
      paymentInFlight: async () => await vault.paymentInFlight(),
      notifier: opts.notifier,
      now,
      log: opts.notary.log,
      config: opts.notary.config
    })

  const connectLimiter = new RateLimiter(opts.connectRateLimit?.max ?? 10, opts.connectRateLimit?.windowMs ?? 10 * 60_000, now)

  const app = express()
  app.locals.notary = notary
  app.disable('x-powered-by')
  if (opts.trustProxy === true) app.set('trust proxy', 1)
  app.use(express.static(PUBLIC_DIR))
  // Funding BEEFs carry the transaction's unconfirmed ancestry, so allow more than a plain request needs.
  app.use(express.json({ limit: '2mb' }))

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next) }

  const publicUrl = (req: Request): string => opts.publicUrl?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`

  /**
   * Issues a one-time connection code for an agent (inside the caller's
   * transaction). Without an open vault the old API key is revoked at once;
   * with one it keeps working until the code is used, so a running agent
   * is not cut off before its replacement connects.
   */
  const issueConnectCode = async (trx: Knex.Transaction, agentId: string, req: Request): Promise<{ connectCode: string, connectUrl: string, expiresAt: string, oldKeyRevoked: boolean }> => {
    const s = store.with(trx)
    // Read through the transaction: the database has a single connection.
    const vaultOpen = (await vaultStore.with(trx).getVault(agentId))?.status === 'open'
    if (!vaultOpen) await s.replaceAgentKey(agentId, hashAgentKey(generateAgentKey()), '')
    const code = generateConnectCode()
    const expiresAt = now() + CONNECT_CODE_TTL_MS
    await s.insertConnectCode(agentId, hashConnectCode(code), expiresAt, now())
    await audit.with(trx).append('admin', 'agent.connect_code_issued', { agentId, expiresAt: iso(expiresAt), oldKeyRevoked: !vaultOpen })
    return { connectCode: code, connectUrl: `${publicUrl(req)}/connect#${code}`, expiresAt: iso(expiresAt)!, oldKeyRevoked: !vaultOpen }
  }

  const requireAgent = (req: Request, res: Response, next: NextFunction): void => {
    const unauthorized = (): void => { res.status(401).json({ error: 'missing or invalid agent key' }) }
    const key = bearer(req)
    if (key === undefined || !isAgentKey(key)) { unauthorized(); return }
    store.findAgentByKeyHash(hashAgentKey(key)).then(agent => {
      if (agent === undefined) { unauthorized(); return }
      // Disabling revokes the key already; this also holds if a key ever outlived its agent.
      if (agent.status !== 'active') { res.status(401).json({ error: 'agent disabled' }); return }
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

  // The merchants this agent may pay (from its allowed hosts), so the agent needs no merchant list of its own.
  app.get('/v1/services', requireAgent, wrap(async (_req, res) => {
    res.json({ merchants: merchantsFor((await store.getRules(agentOf(res).id)).allowedHosts) })
  }))

  // ── Onboarding: exchange a one-time connection code for the agent's API key ──
  app.get('/connect', (_req, res) => { res.sendFile('connect.html', { root: PUBLIC_DIR }) })

  app.post('/v1/connect', wrap(async (req, res) => {
    const refused = (): void => { res.status(401).json({ error: 'invalid, expired or already used connection code' }) }
    if (!connectLimiter.hit(req.ip ?? 'unknown')) { res.status(429).json({ error: 'too many attempts; try again later' }); return }
    const code = normalizeConnectCode((req.body ?? {}).code)
    if (code === undefined) { refused(); return }
    const t = now()
    const result = await store.transaction(async trx => {
      const s = store.with(trx)
      // Every active code is compared in constant time: a wrong, expired or used code costs the same as a right one.
      const match = findConnectCode(await s.activeConnectCodes(t), hashConnectCode(code))
      const agent = match === undefined ? undefined : await s.getAgent(match.agentId)
      if (match === undefined || agent?.status !== 'active') return undefined
      if (!await s.useConnectCode(match.codeHash, t)) return undefined
      // The API key is minted now; before this, no one has ever seen a working key for this agent.
      const apiKey = generateAgentKey()
      await s.replaceAgentKey(match.agentId, hashAgentKey(apiKey), agentKeyHint(apiKey))
      await audit.with(trx).append(`agent:${match.agentId}`, 'agent.connected', { agentId: match.agentId, keyHint: maskAgentKey(agentKeyHint(apiKey)) })
      return { agentId: match.agentId, agentName: agent.name, apiKey, rules: await s.getRules(match.agentId) }
    })
    if (result === undefined) { refused(); return }
    // The only response that ever carries the agent's API key.
    res.json({ agentId: result.agentId, agentName: result.agentName, apiKey: result.apiKey, proxyUrl: publicUrl(req), merchants: merchantsFor(result.rules.allowedHosts) })
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
    // The agent starts with a key no one ever sees; its real key is minted when it connects with the code.
    const agent: Agent = { id: `A-${randomBytes(4).toString('hex').toUpperCase()}`, name: name.trim(), keyHint: '', createdAt: now(), status: 'active' }
    const code = await store.transaction(async trx => {
      await store.with(trx).createAgent(agent, hashAgentKey(generateAgentKey()), rules)
      await audit.with(trx).append('admin', 'agent.created', { agentId: agent.id, name: agent.name, rules })
      return await issueConnectCode(trx, agent.id, req)
    })
    res.status(201).json({ id: agent.id, name: agent.name, rules, connectCode: code.connectCode, connectUrl: code.connectUrl, expiresAt: code.expiresAt })
  }))

  /** The agent, unless unknown or deleted (a deleted agent is only kept for its history). */
  const liveAgent = async (id: string): Promise<Agent> => {
    const agent = await store.getAgent(id)
    if (agent === undefined || agent.status === 'deleted') throw new ProxyError(404, 'agent not found')
    return agent
  }

  // A new one-time code, e.g. for an agent on a new machine or one whose code expired.
  admin.post('/agents/:id/connect-code', wrap(async (req, res) => {
    const agent = await liveAgent(String(req.params.id))
    if (agent.status === 'disabled') { res.status(409).json({ error: 'agent is disabled; enable it to issue a new code' }); return }
    const code = await store.transaction(async trx => await issueConnectCode(trx, agent.id, req))
    res.status(201).json({ id: agent.id, ...code })
  }))

  // Never the API key or its hash: only the masked hint. agentPub is the agent's public signing key
  // (the dashboard shows its fingerprint).
  // Disable: the key and codes are revoked, open requests denied, new requests refused. Reversible with enable.
  admin.post('/agents/:id/disable', wrap(async (req, res) => {
    const r = await control.retireAgent(String(req.params.id), 'disabled')
    res.json({ id: r.agent.id, status: r.agent.status, deniedRequests: r.deniedRequests })
  }))

  // Enable: the agent connects again with a new one-time code (its old key stays revoked).
  admin.post('/agents/:id/enable', wrap(async (req, res) => {
    const agent = await liveAgent(String(req.params.id))
    if (agent.status !== 'disabled') { res.status(409).json({ error: `agent is ${agent.status}, not disabled` }); return }
    const code = await store.transaction(async trx => {
      await store.with(trx).setAgentStatus(agent.id, 'active', now())
      await audit.with(trx).append('admin', 'agent.enabled', { agentId: agent.id, name: agent.name })
      return await issueConnectCode(trx, agent.id, req)
    })
    res.status(201).json({ id: agent.id, status: 'active', connectCode: code.connectCode, connectUrl: code.connectUrl, expiresAt: code.expiresAt })
  }))

  // Delete: hidden from the list and never usable again, but its requests, ledger and audit entries are kept.
  // Refused (409) while company money is locked for it: an open vault or unspent request vaults.
  admin.delete('/agents/:id', wrap(async (req, res) => {
    const r = await control.retireAgent(String(req.params.id), 'deleted')
    res.json({ id: r.agent.id, status: r.agent.status, deniedRequests: r.deniedRequests })
  }))

  // ?deleted=1 also lists deleted agents.
  admin.get('/agents', wrap(async (req, res) => {
    const includeDeleted = req.query.deleted === '1' || req.query.deleted === 'true'
    const agents = await store.listAgents({ includeDeleted })
    const vaults = new Map((await vault.listVaults()).map(v => [v.agentId, v]))
    res.json({
      agents: await Promise.all(agents.map(async a => {
        const v = vaults.get(a.id)
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          // No hint: the agent has not connected (or its key was revoked for a new code).
          key: a.keyHint === '' ? null : maskAgentKey(a.keyHint),
          connected: a.keyHint !== '',
          createdAt: iso(a.createdAt),
          rules: await store.getRules(a.id),
          vault: v === undefined
            ? { status: 'no_key', satoshis: 0, agentPub: null, covenant: null }
            : { status: v.status, satoshis: v.status === 'open' ? v.satoshis : 0, agentPub: v.agentPub, covenant: covenantOf(v.lockingScript) }
        }
      }))
    })
  }))

  admin.put('/agents/:id/rules', wrap(async (req, res) => {
    const agent = await liveAgent(String(req.params.id))
    const rules = parseRules(req.body)
    if (typeof rules === 'string') { res.status(400).json({ error: rules }); return }
    await store.transaction(async trx => {
      const s = store.with(trx)
      const before = await s.getRules(agent.id)
      await s.setRules(agent.id, rules)
      await audit.with(trx).append('admin', 'agent.rules_changed', { agentId: agent.id, before, after: rules })
    })
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
      // Euros at payment time, for the payments that have a recorded rate.
      totalEurCents: rows.reduce((s, r) => s + (r.eurCents ?? 0), 0),
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
  const knownAgent = async (id: string): Promise<string> => (await liveAgent(id)).id

  // The current BSV/EUR rate, as the rules see it (fresh: at most 5 minutes old).
  admin.get('/rate', wrap(async (_req, res) => {
    const q = await opts.rates?.current()
    res.json(q === undefined ? { available: false } : { available: freshQuote(q, now()), rate: q.rate, at: iso(q.at), source: q.source })
  }))

  admin.get('/vaults', wrap(async (_req, res) => {
    const vaults = await vault.listVaults()
    res.json({
      network,
      vaults: await Promise.all(vaults.map(async v => ({
        agentId: v.agentId,
        agentName: v.agentName,
        status: v.status,
        satoshis: v.status === 'open' ? v.satoshis : 0,
        outpoint: v.status === 'open' ? `${v.txid!}.${v.vout!}` : null,
        // v2: the most output 0 of a payment may carry, and the most fee, enforced by every node.
        covenant: covenantOf(v.lockingScript),
        policy: policyOf(await store.getRules(v.agentId)),
        explorerUrl: v.txid === null ? null : txLink(v.txid, network)
      })))
    })
  }))

  admin.get('/vaults/:agentId/params', wrap(async (req, res) => {
    const agentId = await knownAgent(String(req.params.agentId))
    res.json({ ...await vault.params(agentId), policy: policyOf(await store.getRules(agentId)) })
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

  // ── Audit log (hash chain, anchored on BSV by the company's wallet) ─────
  const anchorView = (a: { seq: number, hash: string, txid: string, at: number, source: string, feeSats: number | null }): Record<string, unknown> =>
    ({ seq: a.seq, hash: a.hash, txid: a.txid, at: iso(a.at), source: a.source, feeSats: a.feeSats ?? undefined, explorerUrl: txLink(a.txid, network) })

  // The head, how many entries no anchor covers yet, and whether the log got shorter than an anchor (deleted tail).
  admin.get('/audit/head', wrap(async (_req, res) => {
    res.json(await audit.status())
  }))

  // ?after=<seq>&limit=<n>: entries with seq > after, oldest first; without `after`, the last `limit` entries.
  admin.get('/audit', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000)
    const head = await audit.head()
    const after = req.query.after === undefined ? Math.max(0, head.seq - limit) : Number(req.query.after)
    if (!Number.isSafeInteger(after) || after < 0) { res.status(400).json({ error: 'after must be a sequence number' }); return }
    res.json({
      head,
      entries: (await audit.list(after, limit)).map(e => ({ ...e, at: iso(e.at) })),
      anchors: (await audit.anchors()).map(anchorView)
    })
  }))

  // Incremental by default (only entries after the last verified one); ?full=1 re-checks the whole chain.
  admin.get('/audit/verify', wrap(async (req, res) => {
    const full = req.query.full === '1' || req.query.full === 'true'
    const v = await audit.verify({ full })
    res.json({ ...v, anchors: v.anchors.map(a => ({ ...anchorView(a), matches: a.matches })) })
  }))

  admin.post('/audit/anchors', wrap(async (req, res) => {
    const anchor = await recordAnchor(audit, opts.chainTracker, (req.body ?? {}) as Record<string, unknown>, now())
    res.status(201).json(anchorView(anchor))
  }))

  // ── Notary: the operator's fee wallet that anchors the log when it is idle ──
  admin.get('/notary', wrap(async (_req, res) => {
    if (notary === undefined) { res.json({ enabled: false, reason: opts.notaryDisabledReason ?? 'no notary wallet is configured' }); return }
    const s = await notary.status()
    res.json({ enabled: true, ...s, banner: s.level === 'ok' ? null : alertMessage(s.level, s.anchorsLeft) })
  }))

  admin.post('/notary/topup', wrap(async (req, res) => {
    if (notary === undefined) throw new ProxyError(409, `the notary is disabled: ${opts.notaryDisabledReason ?? 'no notary wallet is configured'}`)
    const r = await notary.acceptTopUp((req.body ?? {}) as Record<string, unknown>)
    res.status(201).json({ ...r, explorerUrl: txLink(r.txid, network) })
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
