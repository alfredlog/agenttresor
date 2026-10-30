/**
 * The agent's MCP server: lets a model (Claude Desktop, Claude Code…) find
 * services, check its budget and pay merchants through the company's
 * spend-control proxy. The agent's own key signs vault payments here, on the
 * agent's machine; the proxy never sees it. The tools themselves are in
 * src/agent/tools.ts, shared with the plain HTTP API.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createAgentTools, payShape, requestIdShape, requestShape, type AgentToolsOptions, type ToolOutcome } from '../agent/tools.js'

export { NOT_CONNECTED, type AgentToolsOptions } from '../agent/tools.js'

export const SERVER_INSTRUCTIONS = [
  'AgentTresor pays online services (HTTP 402, paid in BSV) from a budget your company controls.',
  'Always call check_budget and get_price before paying, so you know the price and what is left.',
  'Give pay_and_fetch a real, specific purpose: it is stored in the company\'s audit log.',
  'Set maxSats to the most you are willing to pay; the payment is refused above it.',
  'If a payment is refused (denied), explain the reason to the user instead of retrying.',
  'If it is pending, the company must approve it by funding it from its wallet: tell the user the request id and use check_request later.'
].join(' ')

const MAX_TEXT = 20_000

type ToolResult = { content: Array<{ type: 'text', text: string }>, isError?: boolean }

/** The outcome as MCP text: the summary, then the structured result as JSON. */
function reply (o: ToolOutcome): ToolResult {
  let text = o.data === undefined ? o.summary : `${o.summary}\n\n${JSON.stringify(o.data, null, 2)}`
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (truncated)`
  return { content: [{ type: 'text', text }], isError: o.isError ?? false }
}

export function createAgentMcpServer (opts: AgentToolsOptions): McpServer {
  const server = new McpServer({ name: 'agenttresor-agent', version: opts.version ?? '0.1.0' }, { instructions: SERVER_INSTRUCTIONS })
  const tools = createAgentTools(opts)

  server.registerTool('show_agent_key', {
    title: 'Show agent key',
    description: 'Shows this agent\'s public signing key and its fingerprint (XXXX-XXXX-XXXX). ' +
      'The company compares the fingerprint with the one on its vault page before funding this agent; give it to the user when asked.',
    annotations: { readOnlyHint: true }
  }, async () => reply(await tools.showAgentKey()))

  server.registerTool('list_services', {
    title: 'List paid services',
    description: 'Lists the services of the merchants the company allows this agent to pay: name, category, method, URL and ' +
      'price in satoshis. Use it to find which URL to call. Prices here are indicative; get_price gives the exact price of a request.',
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async () => reply(await tools.listServices()))

  server.registerTool('check_budget', {
    title: 'Check budget',
    description: 'Shows the company\'s rules for this agent (allowed hosts, max per payment, daily budget, approval threshold), ' +
      'what was spent today, what remains, and the vault balance. Call it before paying.',
    annotations: { readOnlyHint: true }
  }, async () => reply(await tools.checkBudget()))

  server.registerTool('get_price', {
    title: 'Get price',
    description: 'Asks the merchant for the exact price of a request without paying (HTTP 402 challenge). ' +
      'Use the same url, method and body you will pass to pay_and_fetch.',
    inputSchema: requestShape,
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async input => reply(await tools.getPrice(input)))

  server.registerTool('pay_and_fetch', {
    title: 'Pay and fetch',
    description: 'Pays for one request through the company\'s spend control and returns the merchant\'s answer. ' +
      'The agent checks the merchant\'s price itself, refuses above maxSats, and signs the vault payment only if it pays exactly that price. ' +
      'Results: paid (with txid and the answer), pending (needs a human approval: report the request id, do not retry), ' +
      'denied (explain the reason to the user, never retry), paid_not_delivered, or failed.',
    inputSchema: payShape,
    annotations: { openWorldHint: true }
  }, async input => reply(await tools.payAndFetch(input)))

  server.registerTool('check_request', {
    title: 'Check request',
    description: 'Shows the status of an earlier payment request (R-…). If the company has approved (funded) it, pays it now ' +
      'from the funds the company set aside for it (the same price check and signing as pay_and_fetch) and returns the merchant\'s answer.',
    inputSchema: requestIdShape,
    annotations: { openWorldHint: true }
  }, async ({ requestId }) => reply(await tools.checkRequest(requestId)))

  return server
}
