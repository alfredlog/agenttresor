/**
 * Starts the agent's MCP server.
 *   stdio (Claude Desktop / Claude Code):  npm run --silent mcp
 *   Streamable HTTP on MCP_PORT:           npm run mcp:http
 * Settings: mcp-data/agent-config.json, written by `npm run connect <code>`.
 * Env (or the project's .env) overrides it: PROXY_URL, AGENT_API_KEY,
 * MERCHANT_URLS; also MCP_DATA_DIR, and for HTTP MCP_TOKEN, MCP_PORT, MCP_HOST.
 *
 * On stdio, stdout belongs to the MCP protocol: everything else goes to stderr.
 */
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpHttpApp } from './http.js'
import { setupAgent } from './setup.js'

// Claude Desktop starts the server from an unrelated working directory, so paths resolve against the project.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
dotenv.config({ path: join(projectRoot, '.env'), quiet: true })
const log = (msg: string): void => { process.stderr.write(`[agenttresor-mcp] ${msg}\n`) }

const dataDirEnv = process.env.MCP_DATA_DIR ?? 'mcp-data'
const dataDir = isAbsolute(dataDirEnv) ? dataDirEnv : join(projectRoot, dataDirEnv)
const { createServer } = await setupAgent(dataDir, process.env, log)

if (process.argv.includes('--http')) {
  const token = process.env.MCP_TOKEN ?? ''
  if (token === '') throw new Error('MCP_TOKEN must be set')
  const host = process.env.MCP_HOST ?? '127.0.0.1'
  const port = Number(process.env.MCP_PORT ?? 5070)
  const app = createMcpHttpApp({ createServer, token, host })
  app.listen(port, host, () => { log(`MCP over Streamable HTTP on http://${host}:${port}/mcp`) })
} else {
  await createServer().connect(new StdioServerTransport())
  log('MCP over stdio ready')
}
