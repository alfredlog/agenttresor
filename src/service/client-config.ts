/**
 * Client configuration written by `npm run setup`, once and idempotently:
 * a file that is already right is never rewritten (Claude Code drops a server
 * whose .mcp.json changes mid-session).
 *
 *   .mcp.json                     mcpServers.agenttresor = { type: 'http', url: http://127.0.0.1:<port>/mcp }
 *                                 merged: other servers stay; the old file is kept as .mcp.json.bak
 *   .claude/settings.local.json   enabledMcpjsonServers gets "agenttresor" (only ours; never
 *                                 enableAllProjectMcpServers), so Claude Code does not ask again
 *   .gitignore                    gets .mcp.json and .claude/settings.local.json
 *   Claude Desktop (optional)     mcpServers.agenttresor = a stdio bridge to the same /mcp (Claude
 *                                 Desktop's config file only runs local commands), merged, with a backup
 *
 * The URL is the same for every agent: the service serves the ACTIVE agent at
 * /mcp, so switching agents never touches these files. Nothing here holds a key.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localBase } from './env.js'

export const MCP_SERVER_NAME = 'agenttresor'

export type FileChange = 'created' | 'updated' | 'unchanged'

export interface FileResult {
  path: string
  change: FileChange
  /** Where the previous version was saved, if the file was updated. */
  backup?: string
}

export const activeMcpUrl = (port: number): string => `${localBase(port)}/mcp`
export const mcpServerEntry = (port: number): { type: 'http', url: string } => ({ type: 'http', url: activeMcpUrl(port) })

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const format = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

/** The file's JSON object, undefined if it does not exist. Refuses to touch a file that is not a JSON object. */
async function readJsonObject (path: string): Promise<Json | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  if (text.trim() === '') return {}
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(`${path} is not valid JSON; fix or remove it, then run setup again`) }
  if (!isObject(parsed)) throw new Error(`${path} is not a JSON object; fix or remove it, then run setup again`)
  return parsed
}

/**
 * Applies `merge` to the file's object. Writes only if the result differs;
 * `backup` keeps the previous file next to it. With `dryRun`, reports what
 * would change and writes nothing.
 */
async function mergeJsonFile (path: string, merge: (current: Json) => Json, opts: { backup?: boolean, dryRun?: boolean } = {}): Promise<FileResult> {
  const current = await readJsonObject(path)
  const next = merge(structuredClone(current ?? {}))
  if (current !== undefined && sameJson(current, next)) return { path, change: 'unchanged' }
  const result: FileResult = { path, change: current === undefined ? 'created' : 'updated' }
  if (opts.dryRun === true) return result
  await mkdir(dirname(path), { recursive: true })
  if (current !== undefined && opts.backup === true) {
    result.backup = `${path}.bak`
    await copyFile(path, result.backup)
  }
  await writeFile(path, format(next))
  return result
}

/** .mcp.json: our server merged in, every other server kept. */
export async function ensureMcpJson (projectRoot: string, port: number, opts: { dryRun?: boolean } = {}): Promise<FileResult> {
  return await mergeJsonFile(join(projectRoot, '.mcp.json'), cur => {
    const servers = isObject(cur.mcpServers) ? cur.mcpServers : {}
    return { ...cur, mcpServers: { ...servers, [MCP_SERVER_NAME]: mcpServerEntry(port) } }
  }, { backup: true, dryRun: opts.dryRun })
}

/** .claude/settings.local.json: "agenttresor" in enabledMcpjsonServers, every other key kept. */
export async function ensureClaudeSettings (projectRoot: string, opts: { dryRun?: boolean } = {}): Promise<FileResult> {
  return await mergeJsonFile(join(projectRoot, '.claude', 'settings.local.json'), cur => {
    const enabled = Array.isArray(cur.enabledMcpjsonServers) ? cur.enabledMcpjsonServers.filter((s): s is string => typeof s === 'string') : []
    return enabled.includes(MCP_SERVER_NAME) ? cur : { ...cur, enabledMcpjsonServers: [...enabled, MCP_SERVER_NAME] }
  }, { dryRun: opts.dryRun })
}

/** Lines .gitignore must have: per-user files, never committed. */
export const GITIGNORE_ENTRIES = ['.mcp.json', '.mcp.json.bak', '.claude/settings.local.json']

export async function ensureGitignore (projectRoot: string, opts: { dryRun?: boolean } = {}): Promise<FileResult> {
  const path = join(projectRoot, '.gitignore')
  let text = ''
  let existed = true
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    existed = false
  }
  const lines = new Set(text.split(/\r?\n/).map(l => l.trim()))
  const missing = GITIGNORE_ENTRIES.filter(e => !lines.has(e) && !lines.has(`/${e}`))
  if (missing.length === 0) return { path, change: 'unchanged' }
  if (opts.dryRun !== true) {
    const sep = text === '' || text.endsWith('\n') ? '' : '\n'
    await writeFile(path, `${text}${sep}# Claude Code client config for the local agent service (npm run setup)\n${missing.join('\n')}\n`)
  }
  return { path, change: existed ? 'updated' : 'created' }
}

/** Claude Desktop's config file (macOS), or undefined elsewhere. */
export function claudeDesktopConfigPath (home = homedir(), platform = process.platform): string | undefined {
  return platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : undefined
}

/** The command Claude Desktop runs: src/mcp/bridge.ts, a stdio ↔ HTTP bridge to the service's /mcp. */
export function claudeDesktopEntry (projectRoot: string, port: number, nodePath = process.execPath): { command: string, args: string[], env: Record<string, string> } {
  return {
    command: nodePath,
    args: ['--import', pathToFileURL(join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(projectRoot, 'src', 'mcp', 'bridge.ts')],
    env: { AGENTTRESOR_MCP_URL: activeMcpUrl(port) }
  }
}

export async function ensureClaudeDesktop (path: string, projectRoot: string, port: number, opts: { dryRun?: boolean, nodePath?: string } = {}): Promise<FileResult> {
  return await mergeJsonFile(path, cur => {
    const servers = isObject(cur.mcpServers) ? cur.mcpServers : {}
    return { ...cur, mcpServers: { ...servers, [MCP_SERVER_NAME]: claudeDesktopEntry(projectRoot, port, opts.nodePath) } }
  }, { backup: true, dryRun: opts.dryRun })
}

export interface ClientConfigResult {
  mcpJson: FileResult
  settings: FileResult
  gitignore: FileResult
  claudeDesktop?: FileResult
}

/** Everything setup writes for the clients. `dryRun` checks only (doctor). */
export async function ensureClientConfig (
  projectRoot: string, port: number, opts: { claudeDesktop?: string, dryRun?: boolean } = {}
): Promise<ClientConfigResult> {
  const result: ClientConfigResult = {
    mcpJson: await ensureMcpJson(projectRoot, port, opts),
    settings: await ensureClaudeSettings(projectRoot, opts),
    gitignore: await ensureGitignore(projectRoot, opts)
  }
  if (opts.claudeDesktop !== undefined) result.claudeDesktop = await ensureClaudeDesktop(opts.claudeDesktop, projectRoot, port, opts)
  return result
}
