/**
 * The agents the service hosts, one per profile. A profile is loaded the first
 * time it is asked for (so `npm run setup <code>` can add one while the service
 * runs) and loaded again when its agent-config.json changes (a new connection
 * code gives the agent a new API key).
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_CONFIG_FILE } from '../agent/config.js'
import { isAgentId, listProfiles, profileDir, readActiveAgent, readTunnelSecret } from '../agent/profiles.js'
import { setupAgent, type AgentSetup } from '../mcp/setup.js'

export interface AgentRuntime {
  agentId: string
  dir: string
  setup: AgentSetup
}

interface Entry {
  configMtimeMs: number
  runtime: Promise<AgentRuntime>
}

export type AgentLoader = (dir: string, agentId: string, log: (msg: string) => void) => Promise<AgentSetup>

// The service serves several agents, so the single-agent env overrides (PROXY_URL, AGENT_API_KEY, MERCHANT_URLS) do not apply.
const defaultLoader: AgentLoader = async (dir, _agentId, log) => await setupAgent(dir, {}, log)

export class AgentRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor (
    readonly dataDir: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly loader: AgentLoader = defaultLoader
  ) {}

  /** The agent of profile `agentId`, or undefined if there is no such profile. */
  async get (agentId: string): Promise<AgentRuntime | undefined> {
    if (!isAgentId(agentId)) return undefined
    const dir = profileDir(this.dataDir, agentId)
    let mtime: number
    try {
      mtime = (await stat(join(dir, AGENT_CONFIG_FILE))).mtimeMs
    } catch {
      this.entries.delete(agentId)
      return undefined
    }
    const cached = this.entries.get(agentId)
    if (cached !== undefined && cached.configMtimeMs === mtime) return await cached.runtime

    const log = (msg: string): void => { this.log(`[${agentId}] ${msg}`) }
    const runtime = this.loader(dir, agentId, log).then(setup => ({ agentId, dir, setup }))
    this.entries.set(agentId, { configMtimeMs: mtime, runtime })
    // A failed load is not cached: the next request tries again.
    runtime.catch(() => { if (this.entries.get(agentId)?.runtime === runtime) this.entries.delete(agentId) })
    return await runtime
  }

  /** Loads every profile (at start, so problems show up in the log right away). */
  async loadAll (): Promise<AgentRuntime[]> {
    const loaded: AgentRuntime[] = []
    for (const p of await listProfiles(this.dataDir)) {
      try {
        const r = await this.get(p.agentId)
        if (r !== undefined) loaded.push(r)
      } catch (err) {
        this.log(`[${p.agentId}] could not load: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return loaded
  }

  /** The active agent (served at /mcp and /v1), read from disk on every call so `npm run agents use` takes effect at once. */
  async activeAgent (): Promise<string | undefined> {
    return await readActiveAgent(this.dataDir).catch(() => undefined)
  }

  /** The agent's tunnel secret, read from disk on every call so a rotation takes effect at once. */
  async tunnelSecret (agentId: string): Promise<string | undefined> {
    if (!isAgentId(agentId)) return undefined
    return await readTunnelSecret(profileDir(this.dataDir, agentId)).catch(() => undefined)
  }
}
