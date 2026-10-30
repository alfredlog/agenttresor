/**
 * Calls a BRC-121 merchant. The price is always read from an unpaid preflight
 * (402 with x-bsv-sats and x-bsv-server) before anything is paid;
 * create402Fetch would pay blindly. Used by the proxy (to apply the rules) and
 * by the agent (to know the price independently of the proxy).
 */
import { HEADER_SATS, HEADER_SERVER, type PaymentHeaders } from './brc121.js'

/** What the merchant answered (stored for the agent and the audit log). */
export interface MerchantAnswer {
  status: number
  contentType: string | null
  body: unknown
}

export interface MerchantCall {
  url: string
  method: string
  body?: unknown
}

export type Preflight =
  | { kind: 'price', sats: number, serverKey: string }
  | { kind: 'free', answer: MerchantAnswer }
  | { kind: 'invalid', reason: string }

const TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 1_000_000

async function send (call: MerchantCall, payment?: PaymentHeaders): Promise<{ answer: MerchantAnswer, headers: Headers }> {
  const headers: Record<string, string> = { ...(payment as unknown as Record<string, string> | undefined) }
  let body: string | undefined
  if (call.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(call.body)
  }
  const res = await fetch(call.url, { method: call.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  const contentType = res.headers.get('content-type')
  const text = (await res.text()).slice(0, MAX_BODY_CHARS)
  let parsed: unknown = text
  if (contentType?.includes('application/json') === true) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  return { answer: { status: res.status, contentType, body: parsed }, headers: res.headers }
}

/** Sends the request (with payment headers when given). Throws on network errors. */
export async function callMerchant (call: MerchantCall, payment?: PaymentHeaders): Promise<MerchantAnswer> {
  return (await send(call, payment)).answer
}

/** Asks the merchant for its price without paying. Throws on network errors. */
export async function preflight (call: MerchantCall): Promise<Preflight> {
  const { answer, headers } = await send(call)
  if (answer.status !== 402) return { kind: 'free', answer }
  const sats = headers.get(HEADER_SATS)
  const server = headers.get(HEADER_SERVER)
  if (sats === null || !/^[1-9][0-9]{0,15}$/.test(sats) || !Number.isSafeInteger(Number(sats))) {
    return { kind: 'invalid', reason: 'merchant answered 402 without a valid x-bsv-sats price' }
  }
  if (server === null || !/^0[23][0-9a-f]{64}$/.test(server)) {
    return { kind: 'invalid', reason: 'merchant answered 402 without a valid x-bsv-server key' }
  }
  return { kind: 'price', sats: Number(sats), serverKey: server }
}
