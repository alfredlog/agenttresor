/**
 * Spend control: every payment an agent asks for is priced by an unpaid
 * preflight, checked against the company's rules, then paid (or held for a
 * human, or refused). Every request is kept in the ledger.
 *
 * Requests of one agent are serialized (rules check + payment), so two
 * concurrent requests cannot both pass the daily budget. This lock is per
 * process: run one proxy process per database.
 */
import { randomBytes } from 'node:crypto'
import { callMerchant, preflight, type MerchantCall } from './merchant.js'
import { paymentTxid, type Payer } from './payer.js'
import type { Notifier } from './notifier.js'
import { dayStart, evaluate, hostAllowed, type Rules } from './rules.js'
import type { Agent, MerchantAnswer, PaymentRequestRecord, ProxyStore } from './store.js'

export interface PayInput {
  url: string
  method: string
  body?: unknown
  purpose: string
}

/** A request record and the HTTP status to answer with, or a free answer (nothing paid, nothing recorded). */
export type Outcome =
  | { kind: 'record', record: PaymentRequestRecord, httpStatus: number }
  | { kind: 'free', answer: MerchantAnswer }

export class ProxyError extends Error {
  constructor (readonly httpStatus: number, message: string) { super(message) }
}

export interface ServiceOptions {
  store: ProxyStore
  payer: Payer
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
  private readonly payer: Payer
  private readonly notifier: Notifier
  private readonly now: () => number
  private readonly ttl: { pendingMs: number, approvedMs: number }
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor (opts: ServiceOptions) {
    this.store = opts.store
    this.payer = opts.payer
    this.notifier = opts.notifier
    this.now = opts.now
    this.ttl = { pendingMs: opts.pendingTtlMs ?? 7 * 86_400_000, approvedMs: opts.approvedTtlMs ?? 86_400_000 }
  }

  /** POST /v1/pay */
  async requestPayment (agent: Agent, input: PayInput): Promise<Outcome> {
    return await this.withAgentLock(agent.id, async () => {
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
      const refuse = async (status: 'denied' | 'failed', reason: string, httpStatus: number, extra: Partial<PaymentRequestRecord> = {}): Promise<Outcome> => ({
        kind: 'record',
        record: await this.store.insertRequest({ ...base, ...extra, status, reason, decidedAt: now, decidedBy: 'rules' }),
        httpStatus
      })

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

      if (decision.decision === 'needs_approval') {
        const record = await this.store.insertRequest({ ...base, ...priced, status: 'pending' })
        await this.notify(n => n.approvalNeeded(record))
        return { kind: 'record', record, httpStatus: 202 }
      }

      const record = await this.store.insertRequest({ ...base, ...priced, status: 'approved', decidedAt: now, decidedBy: 'rules' })
      return await this.payAndDeliver(record, input, pf.sats, pf.serverKey)
    })
  }

  /** POST /v1/requests/:id/execute: pay an approved request. */
  async execute (agent: Agent, id: string): Promise<Outcome> {
    return await this.withAgentLock(agent.id, async () => {
      const record = await this.getOwnRequest(agent, id)
      if (record.status !== 'approved') {
        throw new ProxyError(409, `request is ${record.status}${record.reason !== null ? `: ${record.reason}` : ''}`)
      }
      const call: MerchantCall = { url: record.url, method: record.method, body: record.body ?? undefined }
      // The approval may be hours old and BRC-121 payments are only valid for 30 s: ask the price again.
      let pf
      try {
        pf = await preflight(call)
      } catch (err) {
        throw new ProxyError(502, `merchant unreachable: ${errorMessage(err)}`)
      }
      if (pf.kind === 'free') return { kind: 'free', answer: pf.answer }
      if (pf.kind === 'invalid') throw new ProxyError(502, pf.reason)

      const fail = async (reason: string): Promise<Outcome> => ({
        kind: 'record', record: await this.store.updateRequest(id, { status: 'failed', reason }), httpStatus: 409
      })
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
      if (decision.decision === 'deny') {
        return { kind: 'record', record: await this.store.updateRequest(id, { status: 'denied', reason: decision.reason, decidedBy: 'rules' }), httpStatus: 403 }
      }
      return await this.payAndDeliver(record, call, pf.sats, pf.serverKey)
    })
  }

  async getOwnRequest (agent: Agent, id: string): Promise<PaymentRequestRecord> {
    await this.store.expireStale(this.now(), this.ttl)
    const record = await this.store.getRequest(id)
    // Another agent's request is reported as missing, not as forbidden.
    if (record === undefined || record.agentId !== agent.id) throw new ProxyError(404, 'request not found')
    return record
  }

  async budget (agent: Agent): Promise<{ rules: Rules, spentTodaySats: number, remainingTodaySats: number, day: string }> {
    const now = this.now()
    const rules = await this.store.getRules(agent.id)
    const spent = await this.store.spentSince(agent.id, dayStart(now))
    return {
      rules,
      spentTodaySats: spent,
      remainingTodaySats: Math.max(0, rules.dailyBudgetSats - spent),
      day: new Date(dayStart(now)).toISOString().slice(0, 10)
    }
  }

  async approve (id: string, by: string): Promise<PaymentRequestRecord> {
    return await this.decide(id, { status: 'approved', decidedBy: by })
  }

  async deny (id: string, by: string, reason: string): Promise<PaymentRequestRecord> {
    return await this.decide(id, { status: 'denied', decidedBy: by, reason })
  }

  async expireStale (): Promise<void> {
    await this.store.expireStale(this.now(), this.ttl)
  }

  private async decide (id: string, patch: Partial<PaymentRequestRecord>): Promise<PaymentRequestRecord> {
    await this.expireStale()
    const record = await this.store.getRequest(id)
    if (record === undefined) throw new ProxyError(404, 'request not found')
    return await this.withAgentLock(record.agentId, async () => {
      const current = (await this.store.getRequest(id))!
      if (current.status !== 'pending') throw new ProxyError(409, `request is ${current.status}, not pending`)
      const decided = await this.store.updateRequest(id, { ...patch, decidedAt: this.now() })
      await this.notify(n => n.decided(decided))
      return decided
    })
  }

  /**
   * Pays and delivers. The sats leave the wallet once the headers are built, so
   * from then on the request counts against the budget whatever the merchant does.
   */
  private async payAndDeliver (record: PaymentRequestRecord, call: MerchantCall, sats: number, serverKey: string): Promise<Outcome> {
    const id = record.id
    let headers
    try {
      headers = await this.payer.pay(call.url, sats, serverKey)
    } catch (err) {
      return { kind: 'record', record: await this.store.updateRequest(id, { status: 'failed', reason: `payment could not be made: ${errorMessage(err)}` }), httpStatus: 502 }
    }
    let txid: string | null = null
    try { txid = paymentTxid(headers) } catch {}
    // Recorded before delivery, so a crash below still leaves the payment in the ledger.
    await this.store.updateRequest(id, {
      status: 'paid_not_delivered', reason: 'delivery in progress', txid, priceSats: sats, serverKey, paidAt: this.now()
    })
    let answer: MerchantAnswer
    try {
      answer = await callMerchant(call, headers)
    } catch (err) {
      return { kind: 'record', record: await this.store.updateRequest(id, { reason: `merchant unreachable after payment: ${errorMessage(err)}` }), httpStatus: 502 }
    }
    if (answer.status >= 200 && answer.status < 300) {
      return { kind: 'record', record: await this.store.updateRequest(id, { status: 'paid', reason: null, response: answer }), httpStatus: 200 }
    }
    return {
      kind: 'record',
      record: await this.store.updateRequest(id, { reason: `merchant answered ${answer.status} after payment`, response: answer }),
      httpStatus: 502
    }
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
