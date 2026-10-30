/**
 * The agent's payment flow through the spend-control proxy:
 *
 *  a) ask the merchant's price directly (unpaid request), so the agent knows it
 *     independently of the proxy, and refuse anything above maxSats;
 *  b) POST /v1/pay (or /execute for an approved request);
 *  c) on 'sign', check the vault transaction against the price from a) and sign
 *     it (signVaultPayment refuses anything else), then POST /sign;
 *  d) if the 20 s signing window passed, build and sign once more;
 *  e) return a structured result.
 */
import type { PrivateKey } from '../shared/bsv.js'
import { preflight, type MerchantAnswer, type MerchantCall } from '../shared/merchant.js'
import type { ProxyClient, ProxyResponse } from './proxy-client.js'
import { signVaultPayment, type VaultSignAnswer } from './vault-signer.js'

export interface PayParams {
  url: string
  method?: string
  body?: unknown
  /** Why the agent pays; it goes into the company's audit log. */
  purpose: string
  /** The most the agent is willing to pay for this request. */
  maxSats: number
}

export type PayResult =
  | { status: 'paid', requestId: string, txid: string, satoshis: number, response: MerchantAnswer }
  | { status: 'free', response: MerchantAnswer }
  | { status: 'pending', requestId: string, satoshis: number, message: string }
  | { status: 'denied', requestId?: string, deniedBy: 'agent' | 'company', reason: string }
  | { status: 'paid_not_delivered', requestId: string, txid: string, satoshis: number, reason: string, response?: MerchantAnswer }
  | { status: 'failed', requestId?: string, reason: string }

export type PriceResult =
  | { status: 'priced', satoshis: number, merchantKey: string }
  | { status: 'free', response: MerchantAnswer }
  | { status: 'failed', reason: string }

export const PENDING_MESSAGE = 'The payment is above the company\'s approval threshold: it is impossible until the company ' +
  'approves it by funding it from its own wallet. Tell the user the request id; check it later with check_request. ' +
  'Do not ask for the same payment again.'

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)

/** The merchant's own price for a request, read without paying. */
export async function getPrice (call: MerchantCall): Promise<PriceResult> {
  try {
    const pf = await preflight(call)
    if (pf.kind === 'free') return { status: 'free', response: pf.answer }
    if (pf.kind === 'invalid') return { status: 'failed', reason: pf.reason }
    return { status: 'priced', satoshis: pf.sats, merchantKey: pf.serverKey }
  } catch (err) {
    return { status: 'failed', reason: `merchant unreachable: ${errorMessage(err)}` }
  }
}

export interface AgentPayerOptions {
  client: ProxyClient
  key: PrivateKey
  /** Highest fee the agent signs for (default 1000 sats). */
  maxFeeSats?: number
}

export class AgentPayer {
  private readonly client: ProxyClient
  private readonly key: PrivateKey
  private readonly maxFeeSats: number

  constructor (opts: AgentPayerOptions) {
    this.client = opts.client
    this.key = opts.key
    this.maxFeeSats = opts.maxFeeSats ?? 1000
  }

  /** pay_and_fetch */
  async payAndFetch (p: PayParams): Promise<PayResult> {
    const call: MerchantCall = { url: p.url, method: (p.method ?? 'GET').toUpperCase(), body: p.body }
    const price = await getPrice(call)
    if (price.status === 'failed') return { status: 'failed', reason: price.reason }
    const expected = price.status === 'priced' ? price.satoshis : 0
    if (expected > p.maxSats) {
      return { status: 'denied', deniedBy: 'agent', reason: `the merchant asks ${expected} sats, above your maxSats of ${p.maxSats}; nothing was sent to the proxy` }
    }
    const res = await this.client.pay({ url: call.url, method: call.method, body: call.body, purpose: p.purpose })
    return await this.settle(res, expected)
  }

  /** check_request: the request's status; an approved request is executed (same signing flow). */
  async checkRequest (requestId: string): Promise<PayResult | { status: string, requestId: string, [k: string]: unknown }> {
    const res = await this.client.getRequest(requestId)
    if (res.status !== 200) return { status: 'failed', requestId, reason: proxyError(res) }
    const r = res.body
    switch (r.status) {
      case 'approved': return await this.executeApproved(requestId, r)
      case 'pending': return { status: 'pending', requestId, satoshis: r.satoshis, message: PENDING_MESSAGE }
      case 'denied': return { status: 'denied', requestId, deniedBy: 'company', reason: r.reason ?? 'denied' }
      case 'paid': return { status: 'paid', requestId, txid: r.txid, satoshis: r.satoshis, response: r.response }
      case 'paid_not_delivered': return { status: 'paid_not_delivered', requestId, txid: r.txid, satoshis: r.satoshis, reason: r.reason, response: r.response }
      default: return { status: r.status, requestId, reason: r.reason }
    }
  }

  /** Same check as pay_and_fetch: the agent reads the price itself and never pays above what was approved. */
  private async executeApproved (requestId: string, r: { url: string, method: string, body?: unknown, satoshis: number }): Promise<PayResult> {
    const price = await getPrice({ url: r.url, method: r.method, body: r.body })
    if (price.status === 'failed') return { status: 'failed', requestId, reason: price.reason }
    const expected = price.status === 'priced' ? price.satoshis : 0
    if (expected > r.satoshis) {
      return { status: 'failed', requestId, reason: `the merchant now asks ${expected} sats, above the ${r.satoshis} sats the company approved` }
    }
    return await this.settle(await this.client.execute(requestId), expected)
  }

  /** Maps a proxy answer to a result; signs and submits on 'sign'. */
  private async settle (res: ProxyResponse, expectedSats: number, retried = false): Promise<PayResult> {
    const b = res.body ?? {}
    if (res.status === 200 && b.status === 'free') return { status: 'free', response: b.response }
    if (res.status === 202) return { status: 'pending', requestId: b.requestId, satoshis: b.satoshis, message: PENDING_MESSAGE }
    if (res.status === 403) return { status: 'denied', requestId: b.requestId, deniedBy: 'company', reason: b.reason ?? b.error ?? 'denied by the company rules' }
    if (res.status !== 200 || b.status !== 'sign') {
      return { status: 'failed', requestId: b.requestId, reason: proxyError(res) }
    }

    const answer = b as VaultSignAnswer
    let signature: string
    try {
      // Output 0 must pay exactly the merchant's own price, read by the agent itself.
      signature = signVaultPayment(answer, this.key, expectedSats, { maxFeeSats: this.maxFeeSats })
    } catch (err) {
      return { status: 'failed', requestId: answer.requestId, reason: `${errorMessage(err)}. Nothing was signed or paid.` }
    }

    const signed = await this.client.sign(answer.requestId, signature)
    const s = signed.body ?? {}
    if (signed.status === 200 && s.status === 'paid') return { status: 'paid', requestId: s.requestId, txid: s.txid, satoshis: s.satoshis, response: s.response }
    if (s.status === 'paid_not_delivered') {
      return { status: 'paid_not_delivered', requestId: s.requestId, txid: s.txid, satoshis: s.satoshis, reason: s.reason, response: s.response }
    }
    if (signed.status === 409 && s.code === 'SIGN_WINDOW_EXPIRED' && !retried) {
      // The signature came too late for BRC-121's 30 s window: build it again once.
      return await this.settle(await this.client.execute(answer.requestId), expectedSats, true)
    }
    return { status: 'failed', requestId: answer.requestId, reason: proxyError(signed) }
  }
}

function proxyError (res: ProxyResponse): string {
  const b = res.body ?? {}
  return `proxy answered ${res.status}: ${String(b.reason ?? b.error ?? b.status ?? 'no details')}`
}
