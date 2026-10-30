/**
 * `npm run connect <code> -- --proxy https://your-proxy`
 * `npm run connect "https://your-proxy/connect#AT-XXXX-XXXX"`
 * Everything goes to stderr; the API key is never printed.
 */
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { connectAgent, parseConnectArgs } from './connect.js'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
dotenv.config({ path: join(projectRoot, '.env'), quiet: true })
const dataDirEnv = process.env.MCP_DATA_DIR ?? 'mcp-data'
const dataDir = isAbsolute(dataDirEnv) ? dataDirEnv : join(projectRoot, dataDirEnv)

try {
  const target = parseConnectArgs(process.argv.slice(2), process.env)
  const r = await connectAgent(target, dataDir)
  process.stderr.write(`Connected as ${r.agentId}. Agent key fingerprint: ${r.fingerprint} — check it on the vault page before funding.\n`)
  process.stderr.write(`Settings saved to ${r.configPath} (mode 0600). Proxy: ${r.proxyUrl}. Merchants: ${r.merchants.map(m => m.name).join(', ') || 'none yet'}.\n`)
  if (r.registration === 'already_open') process.stderr.write('The vault is already funded for this agent key.\n')
} catch (err) {
  process.stderr.write(`Not connected: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
