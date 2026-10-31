/**
 * The agent's connection settings, written once by `npm run connect <code>`:
 * MCP_DATA_DIR/agent-config.json (mode 0600) with the proxy URL, the agent id,
 * its API key and the merchants it may pay. The MCP server reads it; the env
 * vars PROXY_URL, AGENT_API_KEY and MERCHANT_URLS override it.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Merchant } from '../proxy/connect.js'

export const AGENT_CONFIG_FILE = 'agent-config.json'

export interface AgentConfig {
  proxyUrl: string
  agentId: string
  apiKey: string
  merchants: Merchant[]
  connectedAt: string
}

export function agentConfigPath (dataDir: string): string {
  return join(dataDir, AGENT_CONFIG_FILE)
}

/** Writes the config readable by its owner only (the file holds the agent's API key). */
export async function writeAgentConfig (dataDir: string, config: AgentConfig): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = agentConfigPath(dataDir)
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // `mode` only applies when the file is created: tighten an existing one too.
  await chmod(path, 0o600)
  return path
}

/** The saved config, or undefined if the agent has not connected yet. Throws on a damaged file. */
export async function readAgentConfig (dataDir: string): Promise<AgentConfig | undefined> {
  let raw: string
  try {
    raw = await readFile(agentConfigPath(dataDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const c = JSON.parse(raw) as Partial<AgentConfig>
  if (typeof c.proxyUrl !== 'string' || typeof c.agentId !== 'string' || typeof c.apiKey !== 'string' || !Array.isArray(c.merchants)) {
    throw new Error(`${agentConfigPath(dataDir)} is incomplete; run npm run connect <code> again`)
  }
  return c as AgentConfig
}

export interface AgentSettings {
  proxyUrl: string
  apiKey: string
  /** Set only by MERCHANT_URLS; otherwise the agent asks the proxy (GET /v1/services). */
  merchantUrls?: string[]
  agentId?: string
}

/** Config file first, env vars as overrides. Undefined if there is no proxy URL or API key at all. */
export async function resolveAgentSettings (dataDir: string, env: NodeJS.ProcessEnv): Promise<AgentSettings | undefined> {
  const config = await readAgentConfig(dataDir)
  const nonEmpty = (v: string | undefined): string | undefined => v === undefined || v.trim() === '' ? undefined : v.trim()
  const proxyUrl = nonEmpty(env.PROXY_URL) ?? config?.proxyUrl
  const apiKey = nonEmpty(env.AGENT_API_KEY) ?? config?.apiKey
  if (proxyUrl === undefined || apiKey === undefined) return undefined
  const merchants = nonEmpty(env.MERCHANT_URLS)
  return {
    proxyUrl,
    apiKey,
    merchantUrls: merchants === undefined ? undefined : merchants.split(',').map(s => s.trim()).filter(s => s !== ''),
    agentId: config?.agentId
  }
}
