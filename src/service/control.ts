/**
 * Running the agent service in the background: a pid file (MCP_DATA_DIR/agent.pid)
 * keeps it to a single instance, and its output goes to MCP_DATA_DIR/agent.log.
 * The service process takes the pid lock itself, so a second instance is
 * refused however it was started (agent:start, launchd, by hand).
 */
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PID_FILE = 'agent.pid'
export const LOG_FILE = 'agent.log'
export const DEFAULT_PORT = 5070

export class AlreadyRunningError extends Error {
  constructor (readonly pid: number) { super(`the agent service is already running (pid ${pid})`) }
}

export interface ServicePaths {
  projectRoot: string
  dataDir: string
}

export const pidPath = (dataDir: string): string => join(dataDir, PID_FILE)
export const logPath = (dataDir: string): string => join(dataDir, LOG_FILE)
/**
 * The service command (launchd starts it the same way). tsx is loaded with
 * --import rather than through its CLI, which would run the service in a child
 * process with another pid than the one we start and stop.
 */
export const serviceCommand = (projectRoot: string): string[] =>
  [process.execPath, '--import', pathToFileURL(join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(projectRoot, 'src', 'service', 'main.ts')]

export function isAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid of the running service, if its pid file names a live process. */
export async function runningPid (dataDir: string): Promise<number | undefined> {
  let raw: string
  try {
    raw = await readFile(pidPath(dataDir), 'utf8')
  } catch {
    return undefined
  }
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined
}

/**
 * Takes the single-instance lock for this process. Throws AlreadyRunningError
 * if another live process holds it; a stale pid file is replaced. Returns the
 * function that releases it.
 */
export async function acquirePidLock (dataDir: string, pid = process.pid): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = pidPath(dataDir)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx': creating the file is the lock; two processes cannot both succeed.
      await writeFile(path, `${pid}\n`, { flag: 'wx', mode: 0o600 })
      return async () => {
        const current = await readFile(path, 'utf8').catch(() => '')
        if (current.trim() === String(pid)) await unlink(path).catch(() => {})
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = await runningPid(dataDir)
      if (holder !== undefined) throw new AlreadyRunningError(holder)
      await unlink(path).catch(() => {}) // stale: its process is gone
    }
  }
  throw new Error(`could not take the lock ${path}`)
}

export interface Health {
  ok: boolean
  pid?: number
  /** The code the service runs; missing from services older than this field (always stale). */
  version?: { package: string, commit: string, id: string }
}

/** Asks the running service whether it is up. */
export async function serviceHealth (port: number, token?: string): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000)
    })
    return res.ok ? await res.json() as Health : undefined
  } catch {
    return undefined
  }
}

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

/** The last lines of the service log, to show why it did not start. */
export async function logTail (dataDir: string, lines = 15): Promise<string> {
  const text = await readFile(logPath(dataDir), 'utf8').catch(() => '')
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/**
 * Starts the service in the background (detached, output appended to agent.log)
 * and waits until it answers. Refused if it is already running.
 */
export async function startService (paths: ServicePaths, opts: { port: number, token?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }): Promise<number> {
  const running = await runningPid(paths.dataDir)
  if (running !== undefined) throw new AlreadyRunningError(running)
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
  const log = await open(logPath(paths.dataDir), 'a', 0o600)
  const [cmd, ...args] = serviceCommand(paths.projectRoot)
  const child = spawn(cmd, args, { cwd: paths.projectRoot, detached: true, stdio: ['ignore', log.fd, log.fd], env: opts.env ?? process.env })
  child.unref()
  await log.close()

  let exited: number | null | undefined
  child.once('exit', code => { exited = code })
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`the agent service stopped right away (exit ${String(exited)}):\n${await logTail(paths.dataDir)}`)
    const health = await serviceHealth(opts.port, opts.token)
    if (health?.ok === true && health.pid !== undefined && health.pid === child.pid) return health.pid
    await sleep(300)
  }
  throw new Error(`the agent service did not answer on port ${opts.port} in time; see ${logPath(paths.dataDir)}`)
}

/** Stops the background service (SIGTERM, then SIGKILL after `timeoutMs`). False if it was not running. */
export async function stopService (dataDir: string, timeoutMs = 10_000): Promise<boolean> {
  const pid = await runningPid(dataDir)
  if (pid === undefined) return false
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break
    await sleep(200)
  }
  if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  // Normally the service removes it itself; not after a SIGKILL.
  if ((await readFile(pidPath(dataDir), 'utf8').catch(() => '')).trim() === String(pid)) await unlink(pidPath(dataDir)).catch(() => {})
  return true
}
