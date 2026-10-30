/**
 * Spend control: every payment an agent asks for is priced by an unpaid
 * preflight and checked against the company's rules, then
 *  - under the approval threshold: paid from the agent's vault (the agent signs);
 *  - above it: held until the company approves it by funding a request vault
 *    for exactly this payment from its own wallet, then paid from that vault;
 *  - against the rules: refused.
 * Every request is kept in the ledger, and every decision in the audit log:
 * each state change and its audit entry are written in one transaction.
 *
 * Requests of one agent are serialized (rules check + payment), so two
 * concurrent requests cannot both pass the daily budget. This lock is per
 * process: run one proxy process per database.
 */
import { randomBytes } from 'node:crypto'
import type { FundingBody, FinalizedPayment, SignRequest, VaultService } from '../vault/service.js'
import type { RequestVault } from '../vault/store.js'
import type { Knex } from 'knex'
import type { AuditLog } from '../audit/log.js'
import { ProxyError } from './errors.js'
import { callMerchant, preflight, type MerchantCall } from '../shared/merchant.js'
import type { Notifier } from './notifier.js'
import { dayStart, evaluate, hostAllowed, type Rules } from './rules.js'
import type { Agent, MerchantAnswer, PaymentRequestRecord, ProxyStore } from './store.js'

export { ProxyError }

export interface PayInput {
  url: string
  method: string
  body?: unknown
  purpose: string
}

/**
 * A request record and the HTTP status to answer with; a payment the agent
 * must sign; or a free answer (nothing paid, nothing recorded).
 */
export type Outcome =
  | { kind: 'record', record: PaymentRequestRecord, httpStatus: number }
  | { kind: 'sign', record: PaymentRequestRecord, sign: SignRequest }
  | { kind: 'free', answer: MerchantAnswer }

export interface ServiceOptions {
  store: ProxyStore
  vault: VaultService
  audit: AuditLog
  notifier: Notifier
  now: () => number
  /** A pending request expires after this long without a decision (default 7 days). */
  pendingTtlMs?: number
  /** An approved request expires after this long without being executed (default 24 h). */
  approvedTtlMs?: number
}

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)

export function newRequestId (): string {
  return `R-${randomBytes(5).toString('hex').toUpperCase()}`
}

export class SpendControl {
  private readonly store: ProxyStore
  private readonly vault: VaultService
  private readonly audit: AuditLog
  private readonly notifier: Notifier
  private readonly now: () => number
  private readonly ttl: { pendingMs: number, approvedMs: number }
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor (opts: ServiceOptions) {
    this.store = opts.store
    this.vault = opts.vault
    this.audit = opts.audit
    this.notifier = opts.notifier
    this.now = opts.now
    this.ttl = { pendingMs: opts.pendingTtlMs ?? 7 * 86_400_000, approvedMs: opts.approvedTtlMs ?? 86_400_000 }
  }

  /** POST /v1/pay */
  async requestPayment (agent: Agent, input: PayInput): Promise<Outcome> {
    return await this.withAgentLock(agent.id, async () => {
      if (await this.vault.inFlight(agent.id) !== undefined) {
        throw new ProxyError(409, 'a vault payment is already waiting for a signature', { code: 'SIGNATURE_PENDING' })
      }
      const now = this.now()
      const rules = await this.store.getRules(agent.id)
      const host = new URL(input.url).host
      const base: PaymentRequestRecord = {
        id: newRequestId(),
        agentId: agent.id,
        url: input.url,
        method: input.method,
        body: input.body ?? null,
        purpose: input.purpose,
        priceSats: null,
        serverKey: null,
        status: 'pending',
        reason: null,
        txid: null,
        response: null,
        createdAt: now,
        decidedAt: null,
        decidedBy: null,
        paidAt: null
      }
      const refuse = async (status: 'denied' | 'failed', reason: string, httpStatus: number, extra: Partial<PaymentRequestRecord> = {}): Promise<Outcome> => {
        const record = await this.inTransaction(async (store, audit) => {
          const r = await store.insertRequest({ ...base, ...extra, status, reason, decidedAt: now, decidedBy: 'rules' })
          await logCreated(audit, r)
          if (status === 'denied') await audit.append('rules', 'request.decided', { requestId: r.id, agentId: agent.id, decision: 'denied', reason })
          else await audit.append(`agent:${agent.id}`, 'request.failed', { requestId: r.id, agentId: agent.id, reason })
          return r
        })
        return { kind: 'record', record, httpStatus }
      }

      // Unknown hosts are refused before the proxy contacts them at all.
      if (!hostAllowed(rules, host)) return await refuse('denied', `host ${host} is not allowed`, 403)

      let pf
      try {
        pf = await preflight(input)
      } catch (err) {
        return await refuse('failed', `merchant unreachable: ${errorMessage(err)}`, 502)
      }
      if (pf.kind === 'free') return { kind: 'free', answer: pf.answer }
      if (pf.kind === 'invalid') return await refuse('failed', pf.reason, 502)

      const priced = { priceSats: pf.sats, serverKey: pf.serverKey }
      const spent = await this.store.spentSince(agent.id, dayStart(now))
      const decision = evaluate(rules, spent, host, pf.sats)
      if (decision.decision === 'deny') return await refuse('denied', decision.reason, 403, priced)

      // Above the threshold the company funds the payment itself when it approves it.
      if (decision.decision === 'needs_approval') {
        const record = await this.inTransaction(async (store, audit) => {
          const r = await store.insertRequest({ ...base, ...priced, status: 'pending' })
          await logCreated(audit, r)
          return r
        })
        await this.notify(n => n.approvalNeeded(record))
        return { kind: 'record', record, httpStatus: 202 }
      }

      // The agent's vault balance is a hard on-chain cap.
      const short = await this.vault.capacityProblem(agent.id, pf.sats)
      if (short !== undefined) return await refuse('denied', short, 403, priced)

      const record = await this.inTransaction(async (store, audit) => {
        const r = await store.insertRequest({ ...base, ...priced, status: 'approved', decidedAt: now, decidedBy: 'rules' })
        await logCreated(audit, r)
        await audit.append('rules', 'request.decided', { requestId: r.id, agentId: agent.id, decision: 'approved', priceSats: pf.sats })
        return r
      })
      return { kind: 'sign', record, sign: await this.vault.prepare(agent.id, record.id, pf.sats, pf.serverKey) }
    })
  }

  /**
   * POST /v1/requests/:id/execute: build the payment of an approved request,
   * from its request vault if the company funded one, else from the agent's vault.
   */
  async execute (agent: Agent, id: string): Promise<Outcome> {
    return await this.withAgentLock(agent.id, async () => {
      const record = await this.getOwnRequest(agent, id)
      if (record.status !== 'approved') {
        throw new ProxyError(409, `request is ${record.status}${record.reason !== null ? `: ${record.reason}` : ''}`)
      }
      if (await this.vault.inFlight(agent.id) !== undefined) {
        throw new ProxyError(409, 'a vault payment is already waiting for a signature', { code: 'SIGNATURE_PENDING' })
      }
      const call = callOf(record)
      // The approval may be hours old and BRC-121 payments are only valid for 30 s: ask the price again.
      let pf
      try {
        pf = await preflight(call)
      } catch (err) {
        throw new ProxyError(502, `merchant unreachable: ${errorMessage(err)}`)
      }
      if (pf.kind === 'free') return { kind: 'free', answer: pf.answer }
      if (pf.kind === 'invalid') throw new ProxyError(502, pf.reason)

      const fail = async (reason: string): Promise<Outcome> => {
        const failed = await this.inTransaction(async (store, audit) => {
          const r = await store.updateRequest(id, { status: 'failed', reason })
          await audit.append(`agent:${agent.id}`, 'request.failed', { requestId: id, agentId: agent.id, reason })
          return r
        })
        return { kind: 'record', record: failed, httpStatus: 409 }
      }
      const rv = await this.vault.requestVault(id)
      if (rv !== undefined) return await this.executeFromRequestVault(agent, record, rv, pf, fail)
      if (pf.sats > (record.priceSats ?? 0)) {
        return await fail(`price rose from ${String(record.priceSats)} to ${pf.sats} sats after approval; nothing paid`)
      }
      if (record.serverKey !== null && pf.serverKey !== record.serverKey) {
        return await fail('merchant identity key changed after approval; nothing paid')
      }
      // The approval lifts the threshold only: host, per-payment and daily limits still apply.
      const now = this.now()
      const rules = await this.store.getRules(agent.id)
      const decision = evaluate(rules, await this.store.spentSince(agent.id, dayStart(now)), new URL(record.url).host, pf.sats)
      if (decision.decision === 'deny') return await this.denyAtExecute(id, agent.id, decision.reason)
      const short = await this.vault.capacityProblem(agent.id, pf.sats)
      if (short !== undefined) throw new ProxyError(403, short)
      return { kind: 'sign', record, sign: await this.vault.prepare(agent.id, record.id, pf.sats, pf.serverKey) }
    })
  }

  /** The company funded exactly this payment: the price must not have changed at all. */
  private async executeFromRequestVault (
    agent: Agent,
    record: PaymentRequestRecord,
    rv: RequestVault,
    pf: { sats: number, serverKey: string },
    fail: (reason: string) => Promise<Outcome>
  ): Promise<Outcome> {
    if (rv.status !== 'open') throw new ProxyError(409, `the request vault is ${rv.status}`)
    if (pf.sats !== record.priceSats) {
      return await fail(`price changed from ${String(record.priceSats)} to ${pf.sats} sats after approval; nothing paid, the company can reclaim the request vault`)
    }
    if (record.serverKey !== null && pf.serverKey !== record.serverKey) {
      return await fail('merchant identity key changed after approval; nothing paid, the company can reclaim the request vault')
    }
    // The approval funds the payment; host, per-payment and daily limits still apply.
    const now = this.now()
    const rules = await this.store.getRules(agent.id)
    const decision = evaluate(rules, await this.store.spentSince(agent.id, dayStart(now)), new URL(record.url).host, pf.sats)
    if (decision.decision === 'deny') return await this.denyAtExecute(record.id, agent.id, decision.reason)
    return { kind: 'sign', record, sign: await this.vault.prepareFromRequestVault(agent.id, record.id, pf.sats, pf.serverKey) }
  }

  /** The rules still apply at execute time; a denial there is a decision of the rules. */
  private async denyAtExecute (id: string, agentId: string, reason: string): Promise<Outcome> {
    const record = await this.inTransaction(async (store, audit) => {
      const r = await store.updateRequest(id, { status: 'denied', reason, decidedBy: 'rules' })
      await audit.append('rules', 'request.decided', { requestId: id, agentId, decision: 'denied', reason, atExecute: true })
      return r
    })
    return { kind: 'record', record, httpStatus: 403 }
  }

  /** POST /v1/requests/:id/sign: complete, broadcast and deliver the payment the agent signed. */
  async sign (agent: Agent, id: string, signature: unknown): Promise<Outcome> {
    return await this.withAgentLock(agent.id, async () => {
      const record = await this.getOwnRequest(agent, id)
      if (record.status !== 'approved') throw new ProxyError(409, `request is ${record.status}`)
      // Recorded with the payment itself, before delivery: a crash below still leaves it in the ledger.
      const payment = await this.vault.finalize(agent.id, id, signature, async (trx, p) => {
        await this.store.with(trx).updateRequest(id, {
          status: 'paid_not_delivered', reason: 'delivery in progress', txid: p.txid, priceSats: p.priceSats, paidAt: this.now()
        })
      })
      return await this.deliver(record, payment)
    })
  }

  async getOwnRequest (agent: Agent, id: string): Promise<PaymentRequestRecord> {
    await this.expireStale()
    const record = await this.store.getRequest(id)
    // Another agent's request is reported as missing, not as forbidden.
    if (record === undefined || record.agentId !== agent.id) throw new ProxyError(404, 'request not found')
    return record
  }

  async budget (agent: Agent): Promise<{ rules: Rules, spentTodaySats: number, remainingTodaySats: number, day: string, vault: { status: string, satoshis: number, outpoint: string | null } }> {
    const now = this.now()
    const rules = await this.store.getRules(agent.id)
    const spent = await this.store.spentSince(agent.id, dayStart(now))
    return {
      rules,
      spentTodaySats: spent,
      remainingTodaySats: Math.max(0, rules.dailyBudgetSats - spent),
      day: new Date(dayStart(now)).toISOString().slice(0, 10),
      vault: await this.vault.balance(agent.id)
    }
  }

  /** GET /admin/requests/:id/approval: what the company funds to approve this payment. */
  async approvalInfo (id: string): Promise<Record<string, unknown>> {
    await this.expireStale()
    const record = await this.store.getRequest(id)
    if (record === undefined) throw new ProxyError(404, 'request not found')
    if (record.status !== 'pending') throw new ProxyError(409, `request is ${record.status}, not pending`)
    const agent = (await this.store.getAgent(record.agentId))!
    const info = await this.vault.approvalInfo(record.agentId, record.priceSats!)
    return { requestId: id, agentId: agent.id, agentName: agent.name, purpose: record.purpose, url: record.url, method: record.method, priceSats: record.priceSats, ...info }
  }

  /**
   * POST /admin/requests/:id/approve: approving a payment above the threshold
   * means funding it. Without a verified request vault nothing is approved.
   */
  async approve (id: string, by: string, funding: FundingBody): Promise<PaymentRequestRecord> {
    return await this.decide(id, { status: 'approved', decidedBy: by }, async record => {
      if (funding.beef === undefined) {
        throw new ProxyError(400, 'approving a payment above the threshold takes funding it from the company wallet (vault.html?approve=<id>)')
      }
      // SPV and the funding checks first (network), then the request vault is stored with the approval.
      const verified = await this.vault.verifyRequestFunding(record.agentId, id, record.priceSats!, funding)
      return async trx => { await this.vault.recordRequestFunding(trx, verified) }
    })
  }

  /** The company reclaimed a request vault: a still-approved request can no longer be paid. */
  async requestVaultReclaimed (requestId: string, txid: unknown): Promise<RequestVault> {
    return await this.inTransaction(async (store, audit, trx) => {
      const rv = await this.vault.markRequestVaultReclaimed(requestId, txid, trx)
      const record = await store.getRequest(requestId)
      if (record?.status === 'approved') {
        const reason = 'the company reclaimed the approval funds'
        await store.updateRequest(requestId, { status: 'failed', reason })
        await audit.append('company', 'request.failed', { requestId, agentId: record.agentId, reason })
      }
      return rv
    })
  }

  async deny (id: string, by: string, reason: string): Promise<PaymentRequestRecord> {
    return await this.decide(id, { status: 'denied', decidedBy: by, reason })
  }

  async expireStale (): Promise<void> {
    await this.inTransaction(async (store, audit) => {
      for (const r of await store.expireStale(this.now(), this.ttl)) {
        await audit.append('rules', 'request.expired', { requestId: r.id, agentId: r.agentId, was: r.was })
      }
    })
  }

  /**
   * Decides a pending request. `prepare` may check things over the network
   * first; the write step it returns runs in the decision's transaction.
   */
  private async decide (
    id: string,
    patch: Partial<PaymentRequestRecord>,
    prepare?: (record: PaymentRequestRecord) => Promise<(trx: Knex.Transaction) => Promise<void>>
  ): Promise<PaymentRequestRecord> {
    await this.expireStale()
    const record = await this.store.getRequest(id)
    if (record === undefined) throw new ProxyError(404, 'request not found')
    return await this.withAgentLock(record.agentId, async () => {
      const current = (await this.store.getRequest(id))!
      if (current.status !== 'pending') throw new ProxyError(409, `request is ${current.status}, not pending`)
      const alsoWrite = prepare === undefined ? undefined : await prepare(current)
      const decided = await this.inTransaction(async (store, audit, trx) => {
        if (alsoWrite !== undefined) await alsoWrite(trx)
        const d = await store.updateRequest(id, { ...patch, decidedAt: this.now() })
        // Approving is the company funding the payment from its wallet; denying is the admin on the dashboard.
        await audit.append(patch.status === 'approved' ? 'company' : 'admin', 'request.decided', {
          requestId: id, agentId: d.agentId, decision: patch.status, priceSats: d.priceSats, reason: patch.reason
        })
        return d
      })
      await this.notify(n => n.decided(decided))
      return decided
    })
  }

  /**
   * Sends the paid request to the merchant. The payment is on chain already,
   * so from here on it counts against the budget whatever the merchant does.
   */
  private async deliver (record: PaymentRequestRecord, payment: FinalizedPayment): Promise<Outcome> {
    const id = record.id
    let answer: MerchantAnswer
    try {
      answer = await callMerchant(callOf(record), payment.headers)
    } catch (err) {
      return await this.notDelivered(record, payment, `merchant unreachable after payment: ${errorMessage(err)}`)
    }
    if (answer.status >= 200 && answer.status < 300) {
      const paid = await this.inTransaction(async (store, audit) => {
        const r = await store.updateRequest(id, { status: 'paid', reason: null, response: answer })
        await audit.append(`agent:${record.agentId}`, 'request.paid', { requestId: id, agentId: record.agentId, txid: payment.txid, priceSats: payment.priceSats, merchantStatus: answer.status })
        return r
      })
      return { kind: 'record', record: paid, httpStatus: 200 }
    }
    return await this.notDelivered(record, payment, `merchant answered ${answer.status} after payment`, answer)
  }

  private async notDelivered (record: PaymentRequestRecord, payment: FinalizedPayment, reason: string, answer?: MerchantAnswer): Promise<Outcome> {
    const updated = await this.inTransaction(async (store, audit) => {
      const r = await store.updateRequest(record.id, { reason, response: answer })
      await audit.append(`agent:${record.agentId}`, 'request.paid_not_delivered', { requestId: record.id, agentId: record.agentId, txid: payment.txid, priceSats: payment.priceSats, reason })
      return r
    })
    return { kind: 'record', record: updated, httpStatus: 502 }
  }

  /**
   * Runs `fn` with the store and the audit log bound to one transaction, so a
   * state change and its audit entry commit or roll back together. Inside, use
   * only the bound store and log: the database has a single connection.
   */
  private async inTransaction<T> (fn: (store: ProxyStore, audit: AuditLog, trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.store.transaction(async trx => await fn(this.store.with(trx), this.audit.with(trx), trx))
  }

  private async notify (call: (n: Notifier) => Promise<void>): Promise<void> {
    try {
      await call(this.notifier)
    } catch (err) {
      console.error('notifier failed:', errorMessage(err))
    }
  }

  private async withAgentLock<T> (agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    this.locks.set(agentId, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(agentId) === tail) this.locks.delete(agentId)
    }
  }
}

/** request.created: what was asked, by whom, at what price (never the request body). */
async function logCreated (audit: AuditLog, r: PaymentRequestRecord): Promise<void> {
  await audit.append(`agent:${r.agentId}`, 'request.created', {
    requestId: r.id, agentId: r.agentId, url: r.url, method: r.method, purpose: r.purpose, priceSats: r.priceSats, status: r.status
  })
}

function callOf (record: PaymentRequestRecord): MerchantCall {
  return { url: record.url, method: record.method, body: record.body ?? undefined }
}
