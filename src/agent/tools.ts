/**
 * What the agent can do, independent of how it is asked: the MCP tools
 * (src/mcp/server.ts) and the plain HTTP API (src/service/api.ts) both call
 * these and return the same structured data. Each outcome has one sentence a
 * model can act on (`summary`) and the structured result (`data`).
 */
import { z } from 'zod'
import { getPrice, type AgentPayer, type PayResult } from './pay.js'
import type { ProxyClient } from './proxy-client.js'
import { fingerprint } from '../shared/fingerprint.js'
import { formatCents, satsToCents } from '../shared/rate.js'

export const NOT_CONNECTED = 'Not connected. Ask your admin for a connection link and run: npm run setup "<link>"'

export interface AgentToolsOptions {
  payer?: AgentPayer
  client?: ProxyClient
  /** MERCHANT_URLS override: merchant base URLs whose catalogs list_services reads. Default: ask the proxy (GET /v1/services). */
  merchantUrls?: string[]
  /** The agent's public signing key (its private key never leaves agent-key.json). */
  agentPublicKey?: string
  /** Set when the agent is not connected: every tool answers with this message. */
  disconnected?: string
  version?: string
}

export interface ToolOutcome {
  summary: string
  data?: unknown
  isError?: boolean
  /** The tool could not run at all (not connected, proxy unreachable…), as opposed to a business result such as 'denied'. */
  unavailable?: boolean
}

const outcome = (summary: string, data?: unknown, isError = false): ToolOutcome => ({ summary, data, isError })

/** One sentence the model can act on, then the structured result. */
export function describePayResult (r: PayResult | { status: string, [k: string]: unknown }): ToolOutcome {
  switch (r.status) {
    case 'paid': {
      const p = r as Extract<PayResult, { status: 'paid' }>
      return outcome(`Paid ${p.satoshis} sats from the company vault (txid ${p.txid}). The merchant's answer is in "response".`, r)
    }
    case 'free':
      return outcome('No payment was needed. The merchant\'s answer is in "response".', r)
    case 'pending': {
      const p = r as Extract<PayResult, { status: 'pending' }>
      return outcome(`Waiting for approval: request ${p.requestId} (${p.satoshis} sats) is above the company's approval threshold. ` +
        'The company must approve it by funding it from its wallet. Tell the user the request id and call check_request later; ' +
        'do not ask for the same payment again.', r)
    }
    case 'denied': {
      const p = r as Extract<PayResult, { status: 'denied' }>
      const by = p.deniedBy === 'agent' ? 'your own maxSats limit' : 'the company\'s rules'
      return outcome(`Refused by ${by}: ${p.reason}. Explain this to the user; do not retry the same payment.`, r)
    }
    case 'paid_not_delivered': {
      const p = r as Extract<PayResult, { status: 'paid_not_delivered' }>
      return outcome(`Paid ${p.satoshis} sats (txid ${p.txid}) but the merchant did not deliver: ${p.reason}. ` +
        'Tell the user; the company can follow up with the merchant using the txid. Do not pay again.', r, true)
    }
    case 'failed':
      return outcome(`Not paid: ${String((r as { reason?: string }).reason)}. Nothing was paid unless a txid is shown.`, r, true)
    default:
      return outcome(`Request status: ${r.status}.`, r)
  }
}

/** Input shapes, shared by the MCP tool schemas and the HTTP API's validation. */
export const requestShape = {
  url: z.url().describe('Full URL of the paid endpoint, e.g. https://merchant.example/api/report'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method (default GET)'),
  body: z.unknown().optional().describe('JSON body for POST/PUT/PATCH; the price may depend on it')
}
export const payShape = {
  ...requestShape,
  purpose: z.string().trim().min(3).max(500).describe('Why you are paying, in plain words. It goes into the company\'s audit log.'),
  maxSats: z.number().int().positive().describe('The most you are willing to pay for this request, in satoshis')
}
export const requestIdShape = { requestId: z.string().regex(/^R-[0-9A-F]{10}$/).describe('The request id, e.g. R-3F9A1C2B7D') }

export type RequestInput = z.infer<z.ZodObject<typeof requestShape>>
export type PayInput = z.infer<z.ZodObject<typeof payShape>>

export interface AgentTools {
  showAgentKey: () => Promise<ToolOutcome>
  listServices: () => Promise<ToolOutcome>
  checkBudget: () => Promise<ToolOutcome>
  getPrice: (input: RequestInput) => Promise<ToolOutcome>
  payAndFetch: (input: PayInput) => Promise<ToolOutcome>
  checkRequest: (requestId: string) => Promise<ToolOutcome>
}

/**
 * Under EUR rules, a price in euros at the proxy's current rate (rounded up, as
 * the proxy rounds it); undefined under SAT rules or when the proxy cannot say.
 */
async function euroPrice (client: ProxyClient | undefined, sats: number): Promise<{ text: string, data: Record<string, unknown> } | undefined> {
  const b = await client?.budget().then(res => res.status === 200 ? res.body : undefined, () => undefined)
  if (b?.rules?.currency !== 'EUR') return undefined
  if (b.rate == null) return { text: 'Your budget is in euros and the exchange rate is unavailable right now: the payment would be refused.', data: { eurCents: null } }
  const cents = satsToCents(sats, b.rate.rate)
  return {
    text: `That is about ${formatCents(cents)} at 1 BSV = ${b.rate.rate} € (${b.rate.source}); your budget is in euros and the price is converted again at payment time.`,
    data: { eurCents: cents, eurRate: b.rate.rate, rateSource: b.rate.source }
  }
}

export function createAgentTools (opts: AgentToolsOptions): AgentTools {
  // Not connected: every tool answers with the reason, so the model (or caller) can explain what to do.
  const safe = async (fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> => {
    if (opts.disconnected !== undefined) return { summary: opts.disconnected, isError: true, unavailable: true }
    return await fn().catch(err => ({ summary: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true, unavailable: true }))
  }
  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error(NOT_CONNECTED)
    return value
  }
  const proxyFailed = (status: number, body: any): ToolOutcome =>
    ({ summary: `The proxy answered ${status}: ${String(body?.error ?? '')}`, isError: true, unavailable: true })

  return {
    showAgentKey: async () => await safe(async () => {
      const publicKey = need(opts.agentPublicKey)
      const fp = fingerprint(publicKey)
      return outcome(`Agent key fingerprint: ${fp}. The company must see the same fingerprint on its vault page before funding.`, { fingerprint: fp, publicKey })
    }),

    listServices: async () => await safe(async () => {
      let catalogs: string[]
      if (opts.merchantUrls !== undefined && opts.merchantUrls.length > 0) {
        catalogs = opts.merchantUrls.map(base => `${base.replace(/\/$/, '').replace(/\/api\/catalog$/, '')}/api/catalog`)
      } else {
        // The proxy knows which merchants the company allows this agent to pay.
        const res = await need(opts.client).services()
        if (res.status !== 200) return proxyFailed(res.status, res.body)
        catalogs = (res.body.merchants as Array<{ catalogUrl: string }>).map(m => m.catalogUrl)
      }
      if (catalogs.length === 0) return outcome('The company has not allowed any merchant for this agent yet.')
      const merchants = await Promise.all(catalogs.map(async catalogUrl => {
        const root = catalogUrl.replace(/\/api\/catalog$/, '')
        try {
          const res = await fetch(catalogUrl, { signal: AbortSignal.timeout(10_000) })
          if (!res.ok) return { merchant: root, error: `catalog answered ${res.status}` }
          const { items } = await res.json() as { items: Array<{ path: string, [k: string]: unknown }> }
          return { merchant: root, services: items.map(({ path, ...rest }) => ({ ...rest, url: `${root}${path}` })) }
        } catch (err) {
          return { merchant: root, error: `catalog unreachable: ${err instanceof Error ? err.message : String(err)}` }
        }
      }))
      return outcome('Services offered by the configured merchants:', merchants)
    }),

    checkBudget: async () => await safe(async () => {
      const res = await need(opts.client).budget()
      if (res.status !== 200) return proxyFailed(res.status, res.body)
      const b = res.body
      if (b.rules.currency === 'EUR') {
        const rate = b.rate == null
          ? 'The exchange rate is unavailable right now, so every payment is refused until it is back.'
          : `About ${b.remainingTodaySats} sats at 1 BSV = ${b.rate.rate} € (${b.rate.source}).`
        return outcome(`Budget in euros. Remaining today: ${formatCents(b.remainingTodayCents)} of ${formatCents(b.rules.dailyBudgetCents)}. ${rate} ` +
          `Vault: ${b.vault.satoshis} sats (${b.vault.status}). Payments above ${formatCents(b.rules.approvalThresholdCents)} need a human approval; ` +
          `above ${formatCents(b.rules.maxPerPaymentCents)} they are refused. Prices are in sats, converted to euros at payment time and rounded up.`, b)
      }
      return outcome(`Remaining today: ${b.remainingTodaySats} of ${b.rules.dailyBudgetSats} sats; vault: ${b.vault.satoshis} sats (${b.vault.status}). ` +
        `Payments above ${b.rules.approvalThresholdSats} sats need a human approval; above ${b.rules.maxPerPaymentSats} sats they are refused.`, b)
    }),

    getPrice: async ({ url, method, body }) => await safe(async () => {
      const r = await getPrice({ url, method: method ?? 'GET', body })
      if (r.status === 'priced') {
        const eur = await euroPrice(opts.client, r.satoshis)
        return outcome(`The merchant asks ${r.satoshis} sats for this request.${eur === undefined ? '' : ` ${eur.text}`}`, eur === undefined ? r : { ...r, ...eur.data })
      }
      if (r.status === 'free') return outcome('This request is free: no payment needed.', { status: 'free', httpStatus: r.response.status })
      return outcome(`Could not get a price: ${r.reason}`, r, true)
    }),

    payAndFetch: async ({ url, method, body, purpose, maxSats }) => await safe(async () =>
      describePayResult(await need(opts.payer).payAndFetch({ url, method, body, purpose, maxSats }))),

    checkRequest: async requestId => await safe(async () => describePayResult(await need(opts.payer).checkRequest(requestId)))
  }
}
