/**
 * The agent's MCP server: lets a model (Claude Desktop, Claude Code…) find
 * services, check its budget and pay merchants through the company's
 * spend-control proxy. The agent's own key signs vault payments here, on the
 * agent's machine; the proxy never sees it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getPrice, type AgentPayer, type PayResult } from '../agent/pay.js'
import type { ProxyClient } from '../agent/proxy-client.js'
import { fingerprint } from '../shared/fingerprint.js'

export const SERVER_INSTRUCTIONS = [
  'AgentTresor pays online services (HTTP 402, paid in BSV) from a budget your company controls.',
  'Always call check_budget and get_price before paying, so you know the price and what is left.',
  'Give pay_and_fetch a real, specific purpose: it is stored in the company\'s audit log.',
  'Set maxSats to the most you are willing to pay; the payment is refused above it.',
  'If a payment is refused (denied), explain the reason to the user instead of retrying.',
  'If it is pending, the company must approve it by funding it from its wallet: tell the user the request id and use check_request later.'
].join(' ')

const MAX_TEXT = 20_000

export const NOT_CONNECTED = 'Not connected. Ask your admin for a connection code and run: npm run connect <code>'

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

type ToolResult = { content: Array<{ type: 'text', text: string }>, isError?: boolean }

function reply (summary: string, data?: unknown, isError = false): ToolResult {
  let text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (truncated)`
  return { content: [{ type: 'text', text }], isError }
}

/** One sentence the model can act on, then the structured result. */
export function describePayResult (r: PayResult | { status: string, [k: string]: unknown }): ToolResult {
  switch (r.status) {
    case 'paid': {
      const p = r as Extract<PayResult, { status: 'paid' }>
      return reply(`Paid ${p.satoshis} sats from the company vault (txid ${p.txid}). The merchant's answer is in "response".`, r)
    }
    case 'free':
      return reply('No payment was needed. The merchant\'s answer is in "response".', r)
    case 'pending': {
      const p = r as Extract<PayResult, { status: 'pending' }>
      return reply(`Waiting for approval: request ${p.requestId} (${p.satoshis} sats) is above the company's approval threshold. ` +
        'The company must approve it by funding it from its wallet. Tell the user the request id and call check_request later; ' +
        'do not ask for the same payment again.', r)
    }
    case 'denied': {
      const p = r as Extract<PayResult, { status: 'denied' }>
      const by = p.deniedBy === 'agent' ? 'your own maxSats limit' : 'the company\'s rules'
      return reply(`Refused by ${by}: ${p.reason}. Explain this to the user; do not retry the same payment.`, r)
    }
    case 'paid_not_delivered': {
      const p = r as Extract<PayResult, { status: 'paid_not_delivered' }>
      return reply(`Paid ${p.satoshis} sats (txid ${p.txid}) but the merchant did not deliver: ${p.reason}. ` +
        'Tell the user; the company can follow up with the merchant using the txid. Do not pay again.', r, true)
    }
    case 'failed':
      return reply(`Not paid: ${String((r as { reason?: string }).reason)}. Nothing was paid unless a txid is shown.`, r, true)
    default:
      return reply(`Request status: ${r.status}.`, r)
  }
}

const requestShape = {
  url: z.url().describe('Full URL of the paid endpoint, e.g. https://merchant.example/api/report'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method (default GET)'),
  body: z.unknown().optional().describe('JSON body for POST/PUT/PATCH; the price may depend on it')
}

export function createAgentMcpServer (opts: AgentToolsOptions): McpServer {
  const server = new McpServer({ name: 'agenttresor-agent', version: opts.version ?? '0.1.0' }, { instructions: SERVER_INSTRUCTIONS })
  // Not connected: the tools are listed as usual, so the model can explain what to do, but none of them works.
  const safe = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    if (opts.disconnected !== undefined) return reply(opts.disconnected, undefined, true)
    return await fn().catch(err => reply(`Error: ${err instanceof Error ? err.message : String(err)}`, undefined, true))
  }
  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error(NOT_CONNECTED)
    return value
  }

  server.registerTool('show_agent_key', {
    title: 'Show agent key',
    description: 'Shows this agent\'s public signing key and its fingerprint (XXXX-XXXX-XXXX). ' +
      'The company compares the fingerprint with the one on its vault page before funding this agent; give it to the user when asked.',
    annotations: { readOnlyHint: true }
  }, async () => await safe(async () => {
    const publicKey = need(opts.agentPublicKey)
    const fp = fingerprint(publicKey)
    return reply(`Agent key fingerprint: ${fp}. The company must see the same fingerprint on its vault page before funding.`, { fingerprint: fp, publicKey })
  }))

  server.registerTool('list_services', {
    title: 'List paid services',
    description: 'Lists the services of the merchants the company allows this agent to pay: name, category, method, URL and ' +
      'price in satoshis. Use it to find which URL to call. Prices here are indicative; get_price gives the exact price of a request.',
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async () => await safe(async () => {
    let catalogs: string[]
    if (opts.merchantUrls !== undefined && opts.merchantUrls.length > 0) {
      catalogs = opts.merchantUrls.map(base => `${base.replace(/\/$/, '').replace(/\/api\/catalog$/, '')}/api/catalog`)
    } else {
      // The proxy knows which merchants the company allows this agent to pay.
      const res = await need(opts.client).services()
      if (res.status !== 200) return reply(`The proxy answered ${res.status}: ${String(res.body?.error ?? '')}`, undefined, true)
      catalogs = (res.body.merchants as Array<{ catalogUrl: string }>).map(m => m.catalogUrl)
    }
    if (catalogs.length === 0) return reply('The company has not allowed any merchant for this agent yet.')
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
    return reply('Services offered by the configured merchants:', merchants)
  }))

  server.registerTool('check_budget', {
    title: 'Check budget',
    description: 'Shows the company\'s rules for this agent (allowed hosts, max per payment, daily budget, approval threshold), ' +
      'what was spent today, what remains, and the vault balance. Call it before paying.',
    annotations: { readOnlyHint: true }
  }, async () => await safe(async () => {
    const res = await need(opts.client).budget()
    if (res.status !== 200) return reply(`The proxy answered ${res.status}: ${String(res.body?.error ?? '')}`, undefined, true)
    const b = res.body
    return reply(`Remaining today: ${b.remainingTodaySats} of ${b.rules.dailyBudgetSats} sats; vault: ${b.vault.satoshis} sats (${b.vault.status}). ` +
      `Payments above ${b.rules.approvalThresholdSats} sats need a human approval; above ${b.rules.maxPerPaymentSats} sats they are refused.`, b)
  }))

  server.registerTool('get_price', {
    title: 'Get price',
    description: 'Asks the merchant for the exact price of a request without paying (HTTP 402 challenge). ' +
      'Use the same url, method and body you will pass to pay_and_fetch.',
    inputSchema: requestShape,
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ url, method, body }) => await safe(async () => {
    const r = await getPrice({ url, method: method ?? 'GET', body })
    if (r.status === 'priced') return reply(`The merchant asks ${r.satoshis} sats for this request.`, r)
    if (r.status === 'free') return reply('This request is free: no payment needed.', { status: 'free', httpStatus: r.response.status })
    return reply(`Could not get a price: ${r.reason}`, r, true)
  }))

  server.registerTool('pay_and_fetch', {
    title: 'Pay and fetch',
    description: 'Pays for one request through the company\'s spend control and returns the merchant\'s answer. ' +
      'The agent checks the merchant\'s price itself, refuses above maxSats, and signs the vault payment only if it pays exactly that price. ' +
      'Results: paid (with txid and the answer), pending (needs a human approval: report the request id, do not retry), ' +
      'denied (explain the reason to the user, never retry), paid_not_delivered, or failed.',
    inputSchema: {
      ...requestShape,
      purpose: z.string().trim().min(3).max(500).describe('Why you are paying, in plain words. It goes into the company\'s audit log.'),
      maxSats: z.number().int().positive().describe('The most you are willing to pay for this request, in satoshis')
    },
    annotations: { openWorldHint: true }
  }, async ({ url, method, body, purpose, maxSats }) => await safe(async () =>
    describePayResult(await need(opts.payer).payAndFetch({ url, method, body, purpose, maxSats }))))

  server.registerTool('check_request', {
    title: 'Check request',
    description: 'Shows the status of an earlier payment request (R-…). If the company has approved (funded) it, pays it now ' +
      'from the funds the company set aside for it (the same price check and signing as pay_and_fetch) and returns the merchant\'s answer.',
    inputSchema: { requestId: z.string().regex(/^R-[0-9A-F]{10}$/).describe('The request id, e.g. R-3F9A1C2B7D') },
    annotations: { openWorldHint: true }
  }, async ({ requestId }) => await safe(async () => describePayResult(await need(opts.payer).checkRequest(requestId))))

  return server
}
