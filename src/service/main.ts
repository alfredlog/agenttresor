/**
 * The agent service process: hosts every agent profile over HTTP on
 * MCP_HOST:MCP_PORT (default 127.0.0.1:5070). Started by `npm run agent:start`,
 * by launchd, or in the foreground with `npm run agent:run`. Refuses to start
 * if another instance holds the pid lock.
 */
import type { Server } from 'node:http'
import { loadEnv } from './env.js'
import { createAgentServiceApp } from './app.js'
import { acquirePidLock, AlreadyRunningError } from './control.js'
import { migrateLegacyProfile } from '../agent/profiles.js'
import { AgentRegistry } from './registry.js'
import { readCodeVersion } from './version.js'

const { dataDir, port, host, token, projectRoot } = loadEnv()
const log = (msg: string): void => { process.stdout.write(`${new Date().toISOString()} ${msg}\n`) }

let release: () => Promise<void>
try {
  release = await acquirePidLock(dataDir)
} catch (err) {
  log(err instanceof AlreadyRunningError ? `${err.message}; not starting a second one` : `cannot start: ${String(err)}`)
  process.exit(1)
}

try {
  const migrated = await migrateLegacyProfile(dataDir)
  if (migrated.status === 'migrated') log(`moved the single-agent files into the profile of ${migrated.agentId}`)
  if (migrated.status === 'skipped') log(`migration skipped: ${migrated.reason}`)

  const registry = new AgentRegistry(dataDir, log)
  // Read once: after a git pull the service keeps reporting the code it started with, so setup/doctor see it is stale.
  const version = await readCodeVersion(projectRoot)
  const app = createAgentServiceApp({ registry, host, token, version, log })
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => { resolve(s) })
    s.once('error', reject)
  })
  log(`agent service on http://${host}:${port} (pid ${process.pid}, code ${version.id})`)
  const activeId = await registry.activeAgent()
  log(activeId === undefined ? 'no active agent yet: /mcp answers 404 until npm run agents use <agentId>' : `active agent ${activeId}: MCP at http://${host}:${port}/mcp`)
  for (const agent of await registry.loadAll()) {
    const state = agent.setup.disconnected ?? 'ready'
    log(`[${agent.agentId}] ${state}; MCP at http://${host}:${port}/agents/${agent.agentId}/mcp; fingerprint ${agent.setup.fingerprint ?? 'none yet'}`)
  }

  const stop = (signal: string): void => {
    log(`${signal}: stopping`)
    server.close()
    server.closeAllConnections()
    void release().finally(() => process.exit(0))
  }
  process.once('SIGTERM', () => { stop('SIGTERM') })
  process.once('SIGINT', () => { stop('SIGINT') })
} catch (err) {
  log(`cannot start: ${err instanceof Error ? err.message : String(err)}`)
  await release()
  process.exit(1)
}
