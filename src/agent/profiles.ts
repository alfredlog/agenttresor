/**
 * Agent profiles: one directory per agent, MCP_DATA_DIR/agents/<agentId>/
 * (mode 0700) holding its agent-config.json, its own agent-key.json and, once
 * a tunnel was opened, its tunnel secret (all mode 0600). A profile's key is
 * created in its own directory and never copied to another profile.
 */
import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_CONFIG_FILE, readAgentConfig, type AgentConfig } from './config.js'
import { AGENT_KEY_FILE } from './keys.js'
import { fingerprint } from '../shared/fingerprint.js'

export const PROFILES_DIR = 'agents'
export const TUNNEL_SECRET_FILE = 'tunnel-secret'

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isAgentId (id: string): boolean {
  return AGENT_ID.test(id)
}

export function profilesRoot (dataDir: string): string {
  return join(dataDir, PROFILES_DIR)
}

/** The profile directory of an agent; refuses ids that could escape the profiles directory. */
export function profileDir (dataDir: string, agentId: string): string {
  if (!isAgentId(agentId)) throw new Error(`not a valid agent id: ${JSON.stringify(agentId)}`)
  return join(profilesRoot(dataDir), agentId)
}

/** Creates the profile directory (0700) and tightens it if it already existed. */
export async function ensureProfileDir (dataDir: string, agentId: string): Promise<string> {
  const dir = profileDir(dataDir, agentId)
  await mkdir(profilesRoot(dataDir), { recursive: true, mode: 0o700 })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  return dir
}

export interface ProfileInfo {
  agentId: string
  dir: string
  config?: AgentConfig
  /** Public key from agent-key.json; undefined until the key exists. */
  publicKey?: string
  fingerprint?: string
  /** Why the profile cannot be used, if it cannot. */
  error?: string
}

/** The agent's public key, read without loading the private key into a PrivateKey. */
async function readPublicKey (dir: string): Promise<string | undefined> {
  try {
    const file = JSON.parse(await readFile(join(dir, AGENT_KEY_FILE), 'utf8')) as { publicKey?: unknown }
    return typeof file.publicKey === 'string' ? file.publicKey : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

export async function readProfile (dataDir: string, agentId: string): Promise<ProfileInfo | undefined> {
  const dir = profileDir(dataDir, agentId)
  try {
    if (!(await stat(dir)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const info: ProfileInfo = { agentId, dir }
  try {
    info.config = await readAgentConfig(dir)
    info.publicKey = await readPublicKey(dir)
    if (info.publicKey !== undefined) info.fingerprint = fingerprint(info.publicKey)
    if (info.config === undefined) info.error = `no ${AGENT_CONFIG_FILE}`
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err)
  }
  return info
}

/** Every profile, sorted by agent id. */
export async function listProfiles (dataDir: string): Promise<ProfileInfo[]> {
  let names: string[]
  try {
    names = await readdir(profilesRoot(dataDir))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const profiles = await Promise.all(names.filter(isAgentId).sort().map(async id => await readProfile(dataDir, id)))
  return profiles.filter((p): p is ProfileInfo => p !== undefined)
}

const exists = async (path: string): Promise<boolean> => await access(path).then(() => true, () => false)

export type MigrationResult =
  | { status: 'none' }
  | { status: 'migrated', agentId: string, dir: string }
  | { status: 'skipped', reason: string }

/**
 * Moves the single-agent files of earlier versions (MCP_DATA_DIR/agent-config.json
 * and agent-key.json) into the agent's profile. The files are moved, not copied,
 * so the key stays in exactly one place. A profile that already exists is never
 * overwritten.
 */
export async function migrateLegacyProfile (dataDir: string): Promise<MigrationResult> {
  const legacyConfig = join(dataDir, AGENT_CONFIG_FILE)
  const legacyKey = join(dataDir, AGENT_KEY_FILE)
  if (!(await exists(legacyConfig))) {
    if (await exists(legacyKey)) {
      return { status: 'skipped', reason: `${legacyKey} has no ${AGENT_CONFIG_FILE} next to it, so its agent is unknown; it was left in place` }
    }
    return { status: 'none' }
  }
  let config: AgentConfig | undefined
  try {
    config = await readAgentConfig(dataDir)
  } catch (err) {
    return { status: 'skipped', reason: `${legacyConfig} cannot be read: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (config === undefined || !isAgentId(config.agentId)) return { status: 'skipped', reason: `${legacyConfig} has no valid agent id` }

  const dir = profileDir(dataDir, config.agentId)
  if (await exists(dir)) {
    return { status: 'skipped', reason: `profile ${config.agentId} already exists; ${legacyConfig} was left in place` }
  }
  await mkdir(profilesRoot(dataDir), { recursive: true, mode: 0o700 })
  // Build the profile under a temporary name and rename it last, so a crash never leaves half a profile.
  const staging = join(profilesRoot(dataDir), `.migrating-${config.agentId}`)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  if (await exists(legacyKey)) {
    await rename(legacyKey, join(staging, AGENT_KEY_FILE))
    await chmod(join(staging, AGENT_KEY_FILE), 0o600)
  }
  await rename(legacyConfig, join(staging, AGENT_CONFIG_FILE))
  await chmod(join(staging, AGENT_CONFIG_FILE), 0o600)
  await rename(staging, dir)
  await chmod(dir, 0o700)
  return { status: 'migrated', agentId: config.agentId, dir }
}

/** The agent's tunnel secret, or undefined if no tunnel was ever opened for it. */
export async function readTunnelSecret (dir: string): Promise<string | undefined> {
  try {
    const secret = (await readFile(join(dir, TUNNEL_SECRET_FILE), 'utf8')).trim()
    return secret === '' ? undefined : secret
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** Writes a new secret (32 random bytes, base64url, mode 0600), replacing any earlier one. */
export async function rotateTunnelSecret (dir: string): Promise<string> {
  const secret = randomBytes(32).toString('base64url')
  const path = join(dir, TUNNEL_SECRET_FILE)
  await writeFile(path, `${secret}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return secret
}

/** The existing secret, or a new one. */
export async function ensureTunnelSecret (dir: string): Promise<string> {
  return (await readTunnelSecret(dir)) ?? await rotateTunnelSecret(dir)
}
