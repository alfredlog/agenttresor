/**
 * macOS: runs the agent service as a launchd agent of the logged-in user
 * (~/Library/LaunchAgents/de.agenttresor.agent.plist): started at login
 * (RunAtLoad) and restarted if it stops (KeepAlive). Never installed for root.
 * The plist holds paths only, no secrets: the service reads the project's .env.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logPath, serviceCommand, type ServicePaths } from './control.js'

const run = promisify(execFile)

export const LAUNCHD_LABEL = 'de.agenttresor.agent'

export const plistPath = (home = homedir()): string => join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildPlist (paths: ServicePaths, env: Record<string, string> = {}): string {
  const args = serviceCommand(paths.projectRoot).map(a => `    <string>${xml(a)}</string>`).join('\n')
  const envEntries = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath(paths.dataDir))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath(paths.dataDir))}</string>${envEntries === '' ? '' : `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>`}
</dict>
</plist>
`
}

function assertUserAccount (): void {
  if (process.platform !== 'darwin') throw new Error('the launchd service is for macOS only; use npm run agent:start')
  if (process.getuid?.() === 0 || process.env.SUDO_USER !== undefined) {
    throw new Error('do not run this as root or with sudo: the service runs under your own user account')
  }
}

const domain = (): string => `gui/${process.getuid?.() ?? 0}`

export async function isServiceInstalled (): Promise<boolean> {
  return await access(plistPath()).then(() => true, () => false)
}

/** Writes the plist and (re)loads it: launchd starts the service at once and at every login. */
export async function installService (paths: ServicePaths, env: Record<string, string> = {}): Promise<string> {
  assertUserAccount()
  const path = plistPath()
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(path, buildPlist(paths, env), { mode: 0o644 })
  // Unload an earlier version first; it is fine if none was loaded.
  await run('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]).catch(() => {})
  await run('launchctl', ['bootstrap', domain(), path])
  return path
}

export async function uninstallService (): Promise<boolean> {
  assertUserAccount()
  await run('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]).catch(() => {})
  try {
    await unlink(plistPath())
    return true
  } catch {
    return false
  }
}

/** Stops the launchd-managed service until the next login or agent:start (KeepAlive would restart a plain kill). */
export async function stopLaunchdService (): Promise<void> {
  await run('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]).catch(() => {})
}

/** Starts the installed service again after stopLaunchdService. */
export async function startLaunchdService (): Promise<void> {
  assertUserAccount()
  await run('launchctl', ['bootstrap', domain(), plistPath()]).catch(async () => {
    // Already loaded: just make sure it runs.
    await run('launchctl', ['kickstart', `${domain()}/${LAUNCHD_LABEL}`])
  })
}
