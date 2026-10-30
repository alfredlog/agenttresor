/**
 * Commands for the local agent service (see README "Run the agent"):
 *
 *   npm run setup <code> [-- --proxy URL]   connect + run the service + status
 *   npm run agents                          list the agent profiles
 *   npm run agent:start | agent:stop | agent:status
 *   npm run agent:install-service | agent:uninstall-service   (macOS launchd)
 *   npm run agent:tunnel [agentId]          public link for ChatGPT (cloudflared)
 *   npm run agent:tunnel-revoke [agentId]   new secret: the old link stops working
 *
 * Messages go to stderr. No API key, private key or tunnel secret is printed,
 * except the single capability URL printed by agent:tunnel (on stdout).
 */
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { connectAgent, parseConnectArgs } from '../agent/connect.js'
import { ensureTunnelSecret, listProfiles, migrateLegacyProfile, readProfile, readTunnelSecret, rotateTunnelSecret, type ProfileInfo } from '../agent/profiles.js'
import { ProxyClient } from '../agent/proxy-client.js'
import { AlreadyRunningError, logPath, runningPid, serviceHealth, startService, stopService } from './control.js'
import { loadEnv, localBase, mcpJsonFor, mcpUrl, type ServiceEnv } from './env.js'
import { installService, isServiceInstalled, startLaunchdService, stopLaunchdService, uninstallService } from './launchd.js'
import { capabilityUrl, CLOUDFLARED_INSTALL, cloudflaredInstalled, openTunnel } from './tunnel.js'

const say = (msg = ''): void => { process.stderr.write(`${msg}\n`) }
const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))
const macos = process.platform === 'darwin'

/** Only what the service cannot find in the project's .env: an MCP_DATA_DIR given in the shell. Never secrets. */
const launchdEnv = (e: ServiceEnv): Record<string, string> => process.env.MCP_DATA_DIR === undefined ? {} : { MCP_DATA_DIR: e.dataDir }

async function waitForHealth (e: ServiceEnv, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await serviceHealth(e.port, e.token))?.ok === true) return true
    await sleep(300)
  }
  return false
}

async function migrate (e: ServiceEnv): Promise<void> {
  const m = await migrateLegacyProfile(e.dataDir)
  if (m.status === 'migrated') say(`Moved the single-agent files into the profile of ${m.agentId} (${m.dir}).`)
  if (m.status === 'skipped') say(`Note: ${m.reason}.`)
}

/** The profile named on the command line, or the only one there is. */
async function pickProfile (e: ServiceEnv, arg: string | undefined): Promise<ProfileInfo> {
  if (arg !== undefined) {
    const p = await readProfile(e.dataDir, arg)
    if (p?.config === undefined) throw new Error(`no connected agent ${arg} on this machine; see npm run agents`)
    return p
  }
  const all = (await listProfiles(e.dataDir)).filter(p => p.config !== undefined)
  if (all.length === 1) return all[0]
  throw new Error(all.length === 0 ? 'no agent connected yet: npm run setup <code>' : `several agents: name one (${all.map(p => p.agentId).join(', ')})`)
}

async function startCmd (e: ServiceEnv): Promise<void> {
  if (macos && await isServiceInstalled()) {
    if ((await serviceHealth(e.port, e.token))?.ok === true) throw new AlreadyRunningError((await runningPid(e.dataDir)) ?? 0)
    await startLaunchdService()
    if (!await waitForHealth(e)) throw new Error(`the launchd service did not answer; see ${logPath(e.dataDir)}`)
    say(`Agent service running under launchd on ${localBase(e.port)}.`)
    return
  }
  const pid = await startService(e, { port: e.port, token: e.token })
  say(`Agent service running on ${localBase(e.port)} (pid ${pid}). Log: ${logPath(e.dataDir)}`)
}

async function stopCmd (e: ServiceEnv): Promise<void> {
  let stopped = false
  if (macos && await isServiceInstalled()) {
    const pid = await runningPid(e.dataDir)
    await stopLaunchdService()
    stopped = pid !== undefined
    say('Stopped the launchd service until the next login (npm run agent:start starts it again).')
  }
  if (await stopService(e.dataDir)) stopped = true
  say(stopped ? 'Agent service stopped.' : 'The agent service was not running.')
}

interface AgentStatus {
  agentId: string
  proxyUrl?: string
  proxy: string
  vault: string
  fingerprint: string
  tunnel: string
}

async function agentStatus (p: ProfileInfo): Promise<AgentStatus> {
  const s: AgentStatus = {
    agentId: p.agentId,
    proxyUrl: p.config?.proxyUrl,
    proxy: 'not connected',
    vault: 'unknown',
    fingerprint: p.fingerprint ?? 'no key yet',
    tunnel: (await readTunnelSecret(p.dir).catch(() => undefined)) === undefined ? 'no link' : 'link issued (npm run agent:tunnel-revoke to revoke)'
  }
  if (p.config === undefined) { s.proxy = p.error ?? 'not connected'; return s }
  try {
    const res = await new ProxyClient({ proxyUrl: p.config.proxyUrl, apiKey: p.config.apiKey }).budget()
    if (res.status === 200) {
      s.proxy = 'reachable'
      s.vault = `${String(res.body.vault?.satoshis ?? 0)} sats (${String(res.body.vault?.status ?? 'none')}); ${String(res.body.remainingTodaySats)} sats left today`
    } else {
      s.proxy = res.status === 401 ? 'reachable, but the API key was revoked: ask for a new code' : `reachable, answered ${res.status}`
    }
  } catch (err) {
    s.proxy = `unreachable (${err instanceof Error ? err.message : String(err)})`
  }
  return s
}

async function statusCmd (e: ServiceEnv, only?: string): Promise<void> {
  const health = await serviceHealth(e.port, e.token)
  const launchd = macos && await isServiceInstalled()
  say(health?.ok === true
    ? `Agent service: running on ${localBase(e.port)} (pid ${String(health.pid)}${launchd ? ', launchd' : ''}).`
    : `Agent service: not running${launchd ? ' (launchd service installed)' : ''}. Start it with npm run agent:start.`)
  const profiles = (await listProfiles(e.dataDir)).filter(p => only === undefined || p.agentId === only)
  if (profiles.length === 0) { say('No agent connected yet: npm run setup <code>'); return }
  for (const p of profiles) {
    const s = await agentStatus(p)
    say()
    say(`${s.agentId}`)
    say(`  proxy:       ${s.proxyUrl ?? '-'} — ${s.proxy}`)
    say(`  vault:       ${s.vault}`)
    say(`  fingerprint: ${s.fingerprint}`)
    say(`  MCP:         ${mcpUrl(e.port, s.agentId)}`)
    say(`  tunnel:      ${s.tunnel}`)
  }
}

async function agentsCmd (e: ServiceEnv): Promise<void> {
  const profiles = await listProfiles(e.dataDir)
  if (profiles.length === 0) { say('No agent profiles yet: npm run setup <code>'); return }
  // The list itself goes to stdout, so it can be piped.
  for (const p of profiles) {
    process.stdout.write(`${p.agentId}\t${p.config?.proxyUrl ?? `(${p.error ?? 'not connected'})`}\t${p.fingerprint ?? 'no key yet'}\n`)
  }
}

async function tunnelCmd (e: ServiceEnv, agentArg: string | undefined): Promise<void> {
  const p = await pickProfile(e, agentArg)
  if (!cloudflaredInstalled()) throw new Error(CLOUDFLARED_INSTALL)
  if ((await serviceHealth(e.port, e.token))?.ok !== true) throw new Error('the agent service is not running: npm run agent:start')
  const secret = await ensureTunnelSecret(p.dir)
  say(`Opening a Cloudflare quick tunnel to ${localBase(e.port)} …`)
  const tunnel = await openTunnel(e.port, join(e.dataDir, 'tunnel.log'))
  say()
  say(`Paste this URL into ChatGPT as a custom connector (MCP, no authentication) for agent ${p.agentId}.`)
  say('Whoever has it can use this agent within the company\'s rules; keep it private. Revoke: npm run agent:tunnel-revoke ' + p.agentId)
  say()
  process.stdout.write(`${capabilityUrl(tunnel.publicBase, p.agentId, secret)}\n`)
  say()
  say('The tunnel stays open while this command runs (Ctrl-C closes it; the URL changes on the next run).')
  const close = (): void => { tunnel.process.kill('SIGTERM') }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await new Promise<void>(resolve => { tunnel.process.once('exit', () => { resolve() }) })
  say('Tunnel closed.')
}

async function tunnelRevokeCmd (e: ServiceEnv, agentArg: string | undefined): Promise<void> {
  const p = await pickProfile(e, agentArg)
  await rotateTunnelSecret(p.dir)
  say(`New secret for ${p.agentId}: the old link no longer works. Run npm run agent:tunnel ${p.agentId} for a new one.`)
}

async function ensureRunning (e: ServiceEnv): Promise<void> {
  const healthy = (await serviceHealth(e.port, e.token))?.ok === true
  if (macos) {
    // A running service picks up new profiles by itself; otherwise install (or reinstall) the launchd service.
    if (healthy && await isServiceInstalled()) return
    if (healthy) await stopService(e.dataDir)
    const env = launchdEnv(e)
    say(`Installed the launchd service: ${await installService(e, env)}`)
    if (!await waitForHealth(e)) throw new Error(`the launchd service did not answer; see ${logPath(e.dataDir)}`)
    return
  }
  if (!healthy) await startCmd(e)
}

async function offerMcpJson (e: ServiceEnv, agentId: string): Promise<void> {
  const snippet = mcpJsonFor(e.port, agentId)
  say()
  say('Claude Code: put this in .mcp.json in your project (or run: claude mcp add --transport http agenttresor ' + mcpUrl(e.port, agentId) + ')')
  say()
  say(snippet.trimEnd())
  const path = join(e.projectRoot, '.mcp.json')
  if (await access(path).then(() => true, () => false)) {
    say()
    say(`${path} already exists; it was not changed.`)
    return
  }
  if (process.stdin.isTTY !== true) return
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(`\nWrite it to ${path}? [y/N] `)
  rl.close()
  if (/^y(es)?$/i.test(answer.trim())) {
    await writeFile(path, snippet, { flag: 'wx' })
    say(`Wrote ${path} (it is gitignored: it names your agent).`)
  }
}

async function setupCmd (e: ServiceEnv, args: string[]): Promise<void> {
  await migrate(e)
  const r = await connectAgent(parseConnectArgs(args, process.env), e.dataDir)
  say(`Connected as ${r.agentId}. Settings: ${r.configPath} (mode 0600).`)
  await ensureRunning(e)
  await statusCmd(e, r.agentId)
  say()
  say(`Agent key fingerprint: ${r.fingerprint} — check it on the vault page before funding.`)
  await offerMcpJson(e, r.agentId)
}

const USAGE = 'usage: cli.ts setup <code> | agents | start | stop | status | install-service | uninstall-service | tunnel [agentId] | tunnel-revoke [agentId]'

async function main (argv: string[]): Promise<void> {
  const e = loadEnv()
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'setup': return await setupCmd(e, rest)
    case 'agents': await migrate(e); return await agentsCmd(e)
    case 'start': await migrate(e); return await startCmd(e)
    case 'stop': return await stopCmd(e)
    case 'status': await migrate(e); return await statusCmd(e)
    case 'install-service': {
      await migrate(e)
      await stopLaunchdService()
      await stopService(e.dataDir)
      const env = launchdEnv(e)
      say(`Installed ${await installService(e, env)} (starts at login, restarted if it stops).`)
      if (!await waitForHealth(e)) throw new Error(`the service did not answer; see ${logPath(e.dataDir)}`)
      say(`Agent service running on ${localBase(e.port)}.`)
      return
    }
    case 'uninstall-service':
      say(await uninstallService() ? 'Removed the launchd service.' : 'The launchd service was not installed.')
      return
    case 'tunnel': return await tunnelCmd(e, rest[0])
    case 'tunnel-revoke': return await tunnelRevokeCmd(e, rest[0])
    default: throw new Error(USAGE)
  }
}

try {
  await main(process.argv.slice(2))
} catch (err) {
  say(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
