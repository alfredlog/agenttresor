/**
 * `npm run setup [<code|link>]`: leaves a working Claude Code connection on
 * this machine, with no manual edits.
 *
 *   with a code or link   connect the new agent; it becomes active only if no agent is
 *   without               configure the agents already here (repair): if none is active,
 *                         the only one, or the most recently connected, becomes active
 *
 * Then, either way: the service runs (restarted if it runs older code than
 * the checkout), the client config is written once (a file that is already
 * right is never rewritten), and doctor reports what is left.
 */
import { connectAgent, parseConnectArgs } from '../agent/connect.js'
import { activateIfNone, chooseActiveIfNone, readActiveAgent } from '../agent/profiles.js'
import { activeMcpUrl, ensureClientConfig, type ClientConfigResult, type FileResult } from './client-config.js'
import { checkServiceVersion, formatChecks, runDoctor, type Check, type DoctorDeps } from './doctor.js'
import type { ServiceEnv } from './env.js'

export interface SetupDeps extends Omit<DoctorDeps, 'env'> {
  /** Starts the service if it is not running (launchd on macOS). */
  ensureRunning: () => Promise<void>
  /** Claude Desktop's config file, used with --claude-desktop (undefined: not on this platform). */
  claudeDesktopPath?: string
  say: (msg?: string) => void
  /** For tests: the environment npm passes (npm_config_proxy, npm_config_claude_desktop). */
  processEnv?: NodeJS.ProcessEnv
}

export interface SetupResult {
  agentId: string
  connected: boolean
  files: ClientConfigResult
  checks: Check[]
}

/** Whether setup got a code or link (anything besides --proxy URL and --claude-desktop). */
export function hasConnectionCode (args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proxy') { i++; continue }
    if (args[i].startsWith('--proxy=') || args[i] === '--claude-desktop') continue
    return true
  }
  return false
}

const describe = (r: FileResult): string =>
  r.change === 'unchanged' ? `${r.path}: already right, not touched` : `${r.path}: ${r.change}${r.backup === undefined ? '' : ` (previous version kept as ${r.backup})`}`

export async function runSetup (e: ServiceEnv, argv: string[], deps: SetupDeps): Promise<SetupResult> {
  const { say } = deps
  const env = deps.processEnv ?? process.env
  // npm keeps an unknown --flag for itself unless it comes after --: accept both.
  const claudeDesktop = argv.includes('--claude-desktop') || env.npm_config_claude_desktop === 'true'
  const args = argv.filter(a => a !== '--claude-desktop')

  let agentId: string
  let fingerprint: string | undefined
  const connected = hasConnectionCode(args)
  if (connected) {
    const r = await connectAgent(parseConnectArgs(args, env), e.dataDir)
    agentId = r.agentId
    fingerprint = r.fingerprint
    say(`Connected as ${r.agentId}. Settings: ${r.configPath} (mode 0600).`)
    say(await activateIfNone(e.dataDir, r.agentId)
      ? `${r.agentId} is the active agent (served at ${activeMcpUrl(e.port)}).`
      : `The active agent stays ${String(await readActiveAgent(e.dataDir))}; switch with: npm run agents use ${r.agentId}`)
  } else {
    const active = await chooseActiveIfNone(e.dataDir)
    if (active === undefined) throw new Error('no agent is connected on this machine yet: ask the company for a code, then npm run setup <code>')
    agentId = active.agentId
    say(active.chosen ? `Made ${active.agentId} the active agent (served at ${activeMcpUrl(e.port)}).` : `Active agent: ${active.agentId}.`)
  }

  await deps.ensureRunning()
  const health = await deps.health()
  if (health?.ok === true) {
    const v = await checkServiceVersion(deps, health)
    say(v.fixed !== undefined ? `Agent service was ${v.detail}: ${v.fixed}.` : v.ok ? `Agent service ${v.detail}.` : `Agent service ${v.detail}. Fix: ${v.fix ?? ''}`)
  }

  if (claudeDesktop && deps.claudeDesktopPath === undefined) say('--claude-desktop: Claude Desktop\'s config is only written on macOS; skipped.')
  const files = await ensureClientConfig(e.projectRoot, e.port, { claudeDesktop: claudeDesktop ? deps.claudeDesktopPath : undefined })
  say()
  say('Client config:')
  for (const r of [files.mcpJson, files.settings, files.gitignore, files.claudeDesktop]) if (r !== undefined) say(`  ${describe(r)}`)
  if (files.claudeDesktop !== undefined && files.claudeDesktop.change !== 'unchanged') say('  Restart Claude Desktop to load it.')

  if (fingerprint !== undefined) {
    say()
    say(`Agent key fingerprint: ${fingerprint} — the company checks it on the vault page before funding.`)
  }
  const checks = await runDoctor({ ...deps, env: e })
  say()
  say(formatChecks(checks))
  say()
  say('Open a NEW Claude Code session in this folder.')
  return { agentId, connected, files, checks }
}
