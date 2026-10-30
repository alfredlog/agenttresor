/**
 * The agent's own signing key. It is created on the agent's machine, stored in
 * MCP_DATA_DIR/agent-key.json (mode 0600) and never sent anywhere: the proxy
 * only ever receives the public key. Never log the private key.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrivateKey } from '../shared/bsv.js'
import type { ProxyClient } from './proxy-client.js'

export const AGENT_KEY_FILE = 'agent-key.json'

interface KeyFile {
  privateKey: string
  publicKey: string
  createdAt: string
}

export interface LoadedKey {
  key: PrivateKey
  publicKey: string
  path: string
  created: boolean
}

/** Loads the agent key from `dataDir`, or creates it on first start. */
export async function loadOrCreateAgentKey (dataDir: string): Promise<LoadedKey> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, AGENT_KEY_FILE)
  let raw: string | undefined
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  if (raw === undefined) {
    const key = PrivateKey.fromRandom()
    const file: KeyFile = { privateKey: key.toHex(), publicKey: key.toPublicKey().toString(), createdAt: new Date().toISOString() }
    // 'wx' fails if another process created the file in the meantime, instead of overwriting its key.
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    return { key, publicKey: file.publicKey, path, created: true }
  }

  let file: KeyFile
  try {
    file = JSON.parse(raw) as KeyFile
  } catch {
    throw new Error(`${path} is not valid JSON; move it away to create a new agent key`)
  }
  if (typeof file.privateKey !== 'string' || !/^[0-9a-f]{64}$/i.test(file.privateKey)) throw new Error(`${path} holds no valid private key`)
  const key = PrivateKey.fromHex(file.privateKey)
  // Tighten permissions if someone loosened them.
  if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600)
  return { key, publicKey: key.toPublicKey().toString(), path, created: false }
}

/**
 * Registers the agent's public key with the proxy. A 409 because the vault is
 * already open with this same key is fine; with another key the agent cannot
 * sign for that vault, so it stops.
 */
/** The proxy refused the agent's key; `status` 401 means the API key itself is not (or no longer) valid. */
export class AgentKeyError extends Error {
  constructor (message: string, readonly status: number) { super(message) }
}

export async function registerAgentKey (client: ProxyClient, publicKey: string): Promise<'registered' | 'already_open'> {
  const res = await client.registerKey(publicKey)
  if (res.status === 200) return 'registered'
  if (res.status === 409 && res.body?.code === 'VAULT_OPEN') {
    if (res.body.agentPub === publicKey) return 'already_open'
    throw new AgentKeyError(
      `the vault of this agent is funded for another key (${String(res.body.agentPub).slice(0, 16)}…), not this agent's key ` +
      `(${publicKey.slice(0, 16)}…). Restore the original ${AGENT_KEY_FILE}, or ask the company to reclaim the vault and fund it again.`,
      409
    )
  }
  throw new AgentKeyError(`the proxy refused the agent key (${res.status}): ${String(res.body?.error ?? 'no details')}`, res.status)
}
