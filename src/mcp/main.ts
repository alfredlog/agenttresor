/**
 * Starts the agent's MCP server.
 *   stdio (Claude Desktop / Claude Code):  npm run --silent mcp
 *   Streamable HTTP on MCP_PORT:           npm run mcp:http
 * Env (from the environment or the project's .env): PROXY_URL, AGENT_API_KEY,
 * MERCHANT_URLS, MCP_DATA_DIR, and for HTTP MCP_TOKEN, MCP_PORT, MCP_HOST.
 *
 * On stdio, stdout belongs to the MCP protocol: everything else goes to stderr.
 */
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadOrCreateAgentKey, registerAgentKey } from '../agent/keys.js'
import { openAgentTokenWallet } from '../agent/token-wallet.js'
import { fingerprint } from '../shared/fingerprint.js'
import { AgentPayer } from '../agent/pay.js'
import { ProxyClient } from '../agent/proxy-client.js'
import { OverlayClient } from '../token/overlayApi.js'
import { TokenKit } from '../token/token.js'
import { createMcpHttpApp } from './http.js'
import { createAgentMcpServer } from './server.js'

// Claude Desktop starts the server from an unrelated working directory, so paths resolve against the project.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
dotenv.config({ path: join(projectRoot, '.env'), quiet: true })
const log = (msg: string): void => { process.stderr.write(`[agenttresor-mcp] ${msg}\n`) }

const required = (name: string): string => {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`${name} must be set`)
  return v
}

const dataDirEnv = process.env.MCP_DATA_DIR ?? 'mcp-data'
const dataDir = isAbsolute(dataDirEnv) ? dataDirEnv : join(projectRoot, dataDirEnv)
const merchantUrls = (process.env.MERCHANT_URLS ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
const client = new ProxyClient({ proxyUrl: required('PROXY_URL'), apiKey: required('AGENT_API_KEY') })

const agentKey = await loadOrCreateAgentKey(dataDir)
log(`${agentKey.created ? 'created' : 'loaded'} agent key ${agentKey.publicKey.slice(0, 16)}… (${agentKey.path})`)
log(`Agent key fingerprint: ${fingerprint(agentKey.publicKey)}`)
const registration = await registerAgentKey(client, agentKey.publicKey)
log(registration === 'registered'
  ? 'agent key registered with the proxy; the company can now fund the vault'
  : 'vault already open with this agent key')

const payer = new AgentPayer({ client, key: agentKey.key })

const tokenOverlayUrl = process.env.BSV21_OVERLAY_URL?.trim() ?? ''
const tokenId = process.env.BSV21_TOKEN_ID?.trim() ?? ''
let tokenKit: TokenKit | undefined
let closeTokenWallet: (() => Promise<void>) | undefined

if ((tokenOverlayUrl === '') !== (tokenId === '')) {
  throw new Error('Set both BSV21_OVERLAY_URL and BSV21_TOKEN_ID to enable BSV-21 balance checking')
}

if (tokenOverlayUrl !== '' && tokenId !== '') {
  const tokenWallet = await openAgentTokenWallet(
    agentKey.key,
    join(dataDir, 'agent-token-wallet.sqlite')
  )
  tokenKit = new TokenKit(tokenWallet.wallet, new OverlayClient(tokenOverlayUrl))
  closeTokenWallet = tokenWallet.close
  log(`BSV-21 balance checking enabled for token ${tokenId}`)
} else {
  log('BSV-21 balance checking is not configured')
}

const createServer = () => createAgentMcpServer({
  payer,
  client,
  merchantUrls,
  agentPublicKey: agentKey.publicKey,
  tokenKit,
  tokenId: tokenId || undefined,
  companyIdentityKey: process.env.BSV21_COMPANY_IDENTITY_KEY?.trim() || undefined,
})

const shutdown = async (): Promise<void> => {
  try {
    await closeTokenWallet?.()
  } catch (err) {
    log(`could not close token wallet: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    process.exit(0)
  }
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })

if (process.argv.includes('--http')) {
  const host = process.env.MCP_HOST ?? '127.0.0.1'
  const port = Number(process.env.MCP_PORT ?? 5070)
  const app = createMcpHttpApp({ createServer, token: required('MCP_TOKEN'), host })
  app.listen(port, host, () => { log(`MCP over Streamable HTTP on http://${host}:${port}/mcp`) })
} else {
  await createServer().connect(new StdioServerTransport())
  log('MCP over stdio ready')
}