/**
 * stdio ↔ HTTP bridge for Claude Desktop, whose config file only runs local
 * commands: relays every MCP message between stdin/stdout and the local agent
 * service's /mcp (the active agent). Written into Claude Desktop's config by
 * `npm run setup -- --claude-desktop`. It holds no key and keeps no state.
 *
 * Env: AGENTTRESOR_MCP_URL (default http://127.0.0.1:5070/mcp). Diagnostics go
 * to stderr only: stdout is the MCP channel.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = new URL(process.env.AGENTTRESOR_MCP_URL ?? 'http://127.0.0.1:5070/mcp')
const note = (msg: string): void => { process.stderr.write(`agenttresor bridge: ${msg}\n`) }

const http = new StreamableHTTPClientTransport(url)
const stdio = new StdioServerTransport()

stdio.onmessage = message => {
  http.send(message).catch(err => {
    note(`the agent service did not answer (${err instanceof Error ? err.message : String(err)}); is it running? npm run doctor`)
    // Answer requests with an error so the client does not wait forever.
    if ('id' in message && 'method' in message) {
      void stdio.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'the AgentTresor agent service is not reachable: run npm run doctor' } })
    }
  })
}
http.onmessage = message => { void stdio.send(message) }
http.onerror = err => { note(err.message) }
stdio.onclose = () => { void http.close().finally(() => process.exit(0)) }

await http.start()
await stdio.start()
