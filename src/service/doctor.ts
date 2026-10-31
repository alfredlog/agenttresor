/**
 * `npm run doctor`: checks this machine's agent setup and says, in plain words,
 * what is wrong and the exact command that fixes it. A service running older
 * code than the checkout (after `git pull`) is restarted on the spot.
 *
 * Checks: the service runs and is up to date; an agent is active; the proxy is
 * reachable with its key; the key is registered (and its fingerprint); the
 * vault is funded (v1 or v2); .mcp.json and .claude/settings.local.json are right.
 * No key or token is ever printed.
 */
import { listProfiles, readActiveAgent, readProfile } from '../agent/profiles.js'
import { ProxyClient } from '../agent/proxy-client.js'
import { activeMcpUrl, ensureClaudeSettings, ensureMcpJson } from './client-config.js'
import type { Health } from './control.js'
import type { ServiceEnv } from './env.js'
import type { CodeVersion } from './version.js'

export interface Check {
  name: string
  ok: boolean
  detail: string
  /** The command (or step) that fixes it. */
  fix?: string
  /** What doctor already did about it. */
  fixed?: string
}

export interface DoctorDeps {
  env: ServiceEnv
  health: () => Promise<Health | undefined>
  /** The code on disk now. */
  diskVersion: () => Promise<CodeVersion>
  /** Restarts the service; resolves once it answers again. */
  restart: () => Promise<void>
  fetch?: typeof fetch
}

const short = (v: { package: string, commit: string } | undefined): string =>
  v === undefined ? 'an unknown (older) version' : `${v.package} (${v.commit === 'unknown' ? 'no git commit' : v.commit.slice(0, 12)})`

/** Whether the running service runs the code on disk, and if not, restarts it. Shared by setup and doctor. */
export async function checkServiceVersion (deps: Pick<DoctorDeps, 'health' | 'diskVersion' | 'restart'>, health: Health): Promise<Check> {
  const disk = await deps.diskVersion()
  if (health.version?.id === disk.id) return { name: 'service up to date', ok: true, detail: `runs the code on disk, ${short(disk)}` }
  const detail = `stale: it runs ${short(health.version)}, the code on disk is ${short(disk)}`
  try {
    await deps.restart()
    const after = await deps.health()
    if (after?.version?.id === disk.id) return { name: 'service up to date', ok: true, detail, fixed: `restarted it; it now runs ${short(disk)}` }
    return { name: 'service up to date', ok: false, detail: `${detail}; after a restart it still runs ${short(after?.version)}`, fix: 'npm run agent:stop && npm run agent:start' }
  } catch (err) {
    return { name: 'service up to date', ok: false, detail: `${detail}; restart failed: ${err instanceof Error ? err.message : String(err)}`, fix: 'npm run agent:stop && npm run agent:start' }
  }
}

export async function runDoctor (deps: DoctorDeps): Promise<Check[]> {
  const { env } = deps
  const checks: Check[] = []

  // ── The service ──
  const health = await deps.health()
  if (health?.ok === true) {
    checks.push({ name: 'service running', ok: true, detail: `on ${activeMcpUrl(env.port).replace(/\/mcp$/, '')} (pid ${String(health.pid)})` })
    checks.push(await checkServiceVersion(deps, health))
  } else {
    checks.push({ name: 'service running', ok: false, detail: 'the agent service does not answer', fix: 'npm run setup (or npm run agent:start)' })
  }

  // ── The active agent ──
  const activeId = await readActiveAgent(env.dataDir)
  const profile = activeId === undefined ? undefined : await readProfile(env.dataDir, activeId)
  if (profile?.config === undefined) {
    const connected = (await listProfiles(env.dataDir)).filter(p => p.config !== undefined)
    checks.push(activeId === undefined
      ? {
          name: 'active agent',
          ok: false,
          detail: connected.length === 0 ? 'no agent is connected on this machine' : 'no agent is active, so /mcp has nothing to serve',
          fix: connected.length === 0 ? 'ask the company for a connection code, then: npm run setup <code>' : `npm run agents use ${connected.map(p => p.agentId).join(' | ')}`
        }
      : { name: 'active agent', ok: false, detail: `${activeId} cannot be used: ${profile?.error ?? 'its profile is gone'}`, fix: 'ask the company for a new connection code, then: npm run setup <code>' })
  } else {
    const config = profile.config
    checks.push({ name: 'active agent', ok: true, detail: `${profile.agentId}, served at ${activeMcpUrl(env.port)}` })

    // ── The proxy, the key, the vault ──
    let budget: { status: number, body: any } | undefined
    try {
      budget = await new ProxyClient({ proxyUrl: config.proxyUrl, apiKey: config.apiKey, fetch: deps.fetch }).budget()
    } catch (err) {
      checks.push({ name: 'proxy reachable', ok: false, detail: `${config.proxyUrl} does not answer (${err instanceof Error ? err.message : String(err)})`, fix: 'check the network and that the proxy URL is right; it was set by npm run setup <code>' })
    }
    if (budget !== undefined) {
      if (budget.status === 200) {
        checks.push({ name: 'proxy reachable', ok: true, detail: `${config.proxyUrl} accepts this agent's key` })
        const vault = budget.body.vault as { status: string, satoshis: number, version?: 1 | 2 | null, covenant?: { maxSats: number, maxFeeSats: number } | null }
        const fp = profile.fingerprint ?? 'unknown'
        if (vault.status === 'none') {
          checks.push({ name: 'agent key registered', ok: false, detail: 'the proxy has no signing key for this agent', fix: 'ask the company for a new connection code, then: npm run setup <code>' })
        } else {
          checks.push({ name: 'agent key registered', ok: true, detail: `fingerprint ${fp} (the company checks it on the vault page before funding)` })
        }
        if (vault.status === 'open') {
          const kind = vault.version === 2 && vault.covenant != null
            ? `v2 covenant: max ${vault.covenant.maxSats} sats per payment, fee at most ${vault.covenant.maxFeeSats} sats`
            : 'v1'
          checks.push({ name: 'vault funded', ok: true, detail: `${vault.satoshis} sats, ${kind}` })
        } else if (vault.status !== 'none') {
          checks.push({
            name: 'vault funded',
            ok: false,
            detail: vault.status === 'closed' ? 'the company reclaimed the vault: payments are impossible until it is funded again' : 'the vault is not funded yet: payments are impossible',
            fix: `ask the company to fund it on ${config.proxyUrl}/vault.html, after checking the fingerprint ${fp}`
          })
        }
      } else {
        checks.push(budget.status === 401
          ? { name: 'proxy reachable', ok: false, detail: 'the proxy refuses this agent\'s key: it was revoked, or the agent was disabled or deleted', fix: 'ask the company for a new connection code, then: npm run setup <code>' }
          : { name: 'proxy reachable', ok: false, detail: `${config.proxyUrl} answered ${budget.status}`, fix: 'try again later; if it persists, tell the company' })
      }
    }
  }

  // ── Claude Code's config ──
  const mcp = await ensureMcpJson(env.projectRoot, env.port, { dryRun: true }).catch((err: Error) => err)
  checks.push(mcp instanceof Error
    ? { name: '.mcp.json', ok: false, detail: mcp.message, fix: 'fix or remove .mcp.json, then: npm run setup' }
    : mcp.change === 'unchanged'
      ? { name: '.mcp.json', ok: true, detail: `"agenttresor" points at ${activeMcpUrl(env.port)}` }
      : { name: '.mcp.json', ok: false, detail: mcp.change === 'created' ? 'missing' : '"agenttresor" is missing or points elsewhere', fix: 'npm run setup' })
  const settings = await ensureClaudeSettings(env.projectRoot, { dryRun: true }).catch((err: Error) => err)
  checks.push(settings instanceof Error
    ? { name: '.claude/settings.local.json', ok: false, detail: settings.message, fix: 'fix or remove .claude/settings.local.json, then: npm run setup' }
    : settings.change === 'unchanged'
      ? { name: '.claude/settings.local.json', ok: true, detail: '"agenttresor" is approved, so Claude Code does not ask again' }
      : { name: '.claude/settings.local.json', ok: false, detail: '"agenttresor" is not approved: Claude Code would ask on every new session', fix: 'npm run setup' })
  return checks
}

/** The report, one line per check, with the fix under each failure. */
export function formatChecks (checks: Check[]): string {
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
    if (c.fixed !== undefined) lines.push(`    done: ${c.fixed}`)
    if (!c.ok && c.fix !== undefined) lines.push(`    fix:  ${c.fix}`)
  }
  const failed = checks.filter(c => !c.ok).length
  lines.push('', failed === 0 ? 'All good.' : `${failed} ${failed === 1 ? 'problem' : 'problems'} found; the fix is under each one.`)
  return lines.join('\n')
}
