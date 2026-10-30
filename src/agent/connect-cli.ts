/**
 * `npm run connect <code> -- --proxy https://your-proxy`
 * `npm run connect "https://your-proxy/connect#AT-XXXX-XXXX"`
 * Adds an agent profile (MCP_DATA_DIR/agents/<agentId>/). `npm run setup <code>`
 * does the same and also starts the service. Everything goes to stderr; the
 * API key is never printed.
 */
import { connectAgent, parseConnectArgs } from './connect.js'
import { migrateLegacyProfile } from './profiles.js'
import { loadEnv, mcpUrl } from '../service/env.js'

const { dataDir, port } = loadEnv()

try {
  const migrated = await migrateLegacyProfile(dataDir)
  if (migrated.status === 'migrated') process.stderr.write(`Moved the single-agent files into the profile of ${migrated.agentId}.\n`)
  const target = parseConnectArgs(process.argv.slice(2), process.env)
  const r = await connectAgent(target, dataDir)
  process.stderr.write(`Connected as ${r.agentId}. Agent key fingerprint: ${r.fingerprint} — check it on the vault page before funding.\n`)
  process.stderr.write(`Settings saved to ${r.configPath} (mode 0600). Proxy: ${r.proxyUrl}. Merchants: ${r.merchants.map(m => m.name).join(', ') || 'none yet'}.\n`)
  if (r.registration === 'already_open') process.stderr.write('The vault is already funded for this agent key.\n')
  process.stderr.write(`MCP (with the agent service running, npm run agent:start): ${mcpUrl(port, r.agentId)}\n`)
} catch (err) {
  process.stderr.write(`Not connected: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
