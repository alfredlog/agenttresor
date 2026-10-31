/**
 * The agent's MCP server over stdio, for one agent (Claude Desktop and other
 * clients that keep a stdio server running):  npm run --silent mcp
 * It serves AGENT_ID's profile, or the only profile there is. For several
 * agents, and for clients that stop stdio servers between turns, use the
 * agent service instead (npm run setup / agent:start, MCP over HTTP).
 * Env (or the project's .env) overrides the profile: PROXY_URL, AGENT_API_KEY,
 * MERCHANT_URLS; also MCP_DATA_DIR.
 *
 * On stdio, stdout belongs to the MCP protocol: everything else goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { listProfiles, migrateLegacyProfile, profileDir } from '../agent/profiles.js'
import { loadEnv } from '../service/env.js'
import { setupAgent } from './setup.js'

const { dataDir } = loadEnv()
const log = (msg: string): void => { process.stderr.write(`[agenttresor-mcp] ${msg}\n`) }

const migrated = await migrateLegacyProfile(dataDir)
if (migrated.status === 'migrated') log(`moved the single-agent files into the profile of ${migrated.agentId}`)

const wanted = process.env.AGENT_ID?.trim()
const profiles = (await listProfiles(dataDir)).filter(p => p.config !== undefined)
let dir: string
if (wanted !== undefined && wanted !== '') dir = profileDir(dataDir, wanted)
else if (profiles.length === 1) dir = profiles[0].dir
else {
  if (profiles.length > 1) log(`several agents (${profiles.map(p => p.agentId).join(', ')}): set AGENT_ID to choose one`)
  // No (single) profile: only the env overrides can make this agent usable.
  dir = dataDir
}

const agent = await setupAgent(dir, process.env, log)

const shutdown = async (): Promise<void> => {
  try {
    await agent.close?.()
  } catch (err) {
    log(`could not close token wallet: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    process.exit(0)
  }
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })

await agent.createServer().connect(new StdioServerTransport())
log('MCP over stdio ready')