/**
 * Zero-touch client setup: `npm run setup` (with and without a code) leaves an
 * active agent, the client config written once, and a doctor report; the
 * service serves the active agent at /mcp; doctor finds a stale service and
 * an unfunded vault. Mock chain, in a temporary project folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AGENT_CONFIG_FILE } from '../src/agent/config'
import { AGENT_KEY_FILE } from '../src/agent/keys'
import { ACTIVE_FILE, chooseActiveIfNone, profileDir, readActiveAgent, setActiveAgent } from '../src/agent/profiles'
import { fundVault } from '../src/company/vault-client'
import { createAgentServiceApp } from '../src/service/app'
import { claudeDesktopEntry, ensureClaudeDesktop, ensureClientConfig, GITIGNORE_ENTRIES } from '../src/service/client-config'
import { serviceHealth, type Health } from '../src/service/control'
import { runDoctor, type Check } from '../src/service/doctor'
import type { ServiceEnv } from '../src/service/env'
import { AgentRegistry } from '../src/service/registry'
import { hasConnectionCode, runSetup, type SetupDeps } from '../src/service/setup'
import type { CodeVersion } from '../src/service/version'
import { fingerprint } from '../src/shared/fingerprint'
import { ADMIN_TOKEN, createProxyHarness, type ProxyHarness } from './helpers/proxy'

const V1: CodeVersion = { package: '0.1.0', commit: 'a'.repeat(40), id: `0.1.0+${'a'.repeat(40)}` }
const V2: CodeVersion = { package: '0.1.0', commit: 'b'.repeat(40), id: `0.1.0+${'b'.repeat(40)}` }

let h: ProxyHarness
let tmp: string
let env: ServiceEnv
let server: Server
let base: string
const output: string[] = []

/** A new agent on the proxy with its own daily budget (to tell agents apart), and its connection link. */
async function newLink (name: string, dailyBudgetSats: number): Promise<string> {
  const created = await h.admin('/admin/agents', { method: 'POST', body: { name, rules: { allowedHosts: [], maxPerPaymentSats: 1_000, dailyBudgetSats, approvalThresholdSats: 500 } } })
  return created.body.connectUrl
}

/** Setup's dependencies: the test's service, which already runs (and runs the code on disk). */
const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
  ensureRunning: async () => {},
  health: async () => await serviceHealth(Number(new URL(base).port)),
  diskVersion: async () => V1,
  restart: async () => { throw new Error('no restart expected') },
  say: (m = '') => { output.push(m) },
  processEnv: {},
  ...over
})

/** The agent's public key, as its profile stores it (the private key is not read). */
const publicKeyOf = async (agentId: string): Promise<string> =>
  JSON.parse(await readFile(join(profileDir(env.dataDir, agentId), AGENT_KEY_FILE), 'utf8')).publicKey

const checkNamed = (checks: Check[], name: string): Check | undefined => checks.find(c => c.name === name)

/** Contents and mtimes of the files setup writes, to prove a second run touches none of them. */
async function snapshot (paths: string[]): Promise<Array<[string, string, number]>> {
  return await Promise.all(paths.map(async p => [p, await readFile(p, 'utf8'), (await stat(p)).mtimeMs] as [string, string, number]))
}

beforeAll(async () => {
  h = await createProxyHarness()
  tmp = await mkdtemp(join(tmpdir(), 'agenttresor-setup-'))
  const dataDir = join(tmp, 'mcp-data')
  const app = createAgentServiceApp({ registry: new AgentRegistry(dataDir), version: V1 })
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { resolve() }) })
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  env = { projectRoot: join(tmp, 'project'), dataDir, port, host: '127.0.0.1' }
  await mkdir(env.projectRoot)
})
afterAll(async () => {
  await new Promise(resolve => server?.close(resolve))
  await h?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('client config files', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmp, 'merge-')) })

  it('merges into existing files: other servers and keys stay, only "agenttresor" is enabled, then nothing changes', async () => {
    await mkdir(join(dir, '.claude'))
    const oldMcp = { mcpServers: { other: { command: 'other-server', args: ['--x'] } }, note: 'kept' }
    await writeFile(join(dir, '.mcp.json'), JSON.stringify(oldMcp))
    await writeFile(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, enabledMcpjsonServers: ['other'], model: 'x' }))
    await writeFile(join(dir, '.gitignore'), 'node_modules\n.mcp.json')

    const first = await ensureClientConfig(dir, 5070)
    expect([first.mcpJson.change, first.settings.change, first.gitignore.change]).toEqual(['updated', 'updated', 'updated'])
    expect(JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'))).toEqual({
      note: 'kept', mcpServers: { other: oldMcp.mcpServers.other, agenttresor: { type: 'http', url: 'http://127.0.0.1:5070/mcp' } }
    })
    expect(JSON.parse(await readFile(join(dir, '.mcp.json.bak'), 'utf8'))).toEqual(oldMcp)
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8'))
    expect(settings).toEqual({ permissions: { allow: ['Bash(ls)'] }, enabledMcpjsonServers: ['other', 'agenttresor'], model: 'x' })
    expect(settings).not.toHaveProperty('enableAllProjectMcpServers')
    const gitignore = (await readFile(join(dir, '.gitignore'), 'utf8')).split('\n')
    for (const entry of GITIGNORE_ENTRIES) expect(gitignore.filter(l => l === entry)).toHaveLength(1) // .mcp.json was already there: not added twice

    const files = [join(dir, '.mcp.json'), join(dir, '.claude', 'settings.local.json'), join(dir, '.gitignore')]
    const before = await snapshot(files)
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = await ensureClientConfig(dir, 5070)
    expect([second.mcpJson.change, second.settings.change, second.gitignore.change]).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(await snapshot(files)).toEqual(before)
  })

  it('from nothing, enables only "agenttresor"; a file that is not JSON is left alone', async () => {
    const fresh = await mkdtemp(join(tmp, 'fresh-'))
    const r = await ensureClientConfig(fresh, 5070)
    expect([r.mcpJson.change, r.settings.change, r.gitignore.change]).toEqual(['created', 'created', 'created'])
    expect(JSON.parse(await readFile(join(fresh, '.claude', 'settings.local.json'), 'utf8'))).toEqual({ enabledMcpjsonServers: ['agenttresor'] })

    const broken = await mkdtemp(join(tmp, 'broken-'))
    await writeFile(join(broken, '.mcp.json'), '{ not json')
    await expect(ensureClientConfig(broken, 5070)).rejects.toThrow(/not valid JSON/)
    expect(await readFile(join(broken, '.mcp.json'), 'utf8')).toBe('{ not json')
  })

  it('Claude Desktop: the bridge merged into its config, with a backup; a second run changes nothing', async () => {
    const path = join(dir, 'claude_desktop_config.json')
    const old = { mcpServers: { files: { command: 'npx', args: ['fs-server'] } }, globalShortcut: 'Cmd+Space' }
    await writeFile(path, JSON.stringify(old))
    const r = await ensureClaudeDesktop(path, '/opt/agenttresor', 5070, { nodePath: '/usr/bin/node' })
    expect(r).toMatchObject({ change: 'updated', backup: `${path}.bak` })
    const merged = JSON.parse(await readFile(path, 'utf8'))
    expect(merged.globalShortcut).toBe('Cmd+Space')
    expect(merged.mcpServers.files).toEqual(old.mcpServers.files)
    expect(merged.mcpServers.agenttresor).toEqual(claudeDesktopEntry('/opt/agenttresor', 5070, '/usr/bin/node'))
    expect(merged.mcpServers.agenttresor.env).toEqual({ AGENTTRESOR_MCP_URL: 'http://127.0.0.1:5070/mcp' })
    expect(merged.mcpServers.agenttresor.args.at(-1)).toBe('/opt/agenttresor/src/mcp/bridge.ts')
    expect((await ensureClaudeDesktop(path, '/opt/agenttresor', 5070, { nodePath: '/usr/bin/node' })).change).toBe('unchanged')
  })
})

describe('npm run setup', () => {
  let a: string, b: string

  it('tells a code or link from a bare run', () => {
    expect(hasConnectionCode([])).toBe(false)
    expect(hasConnectionCode(['--claude-desktop'])).toBe(false)
    expect(hasConnectionCode(['--proxy', 'https://p.example'])).toBe(false)
    expect(hasConnectionCode(['--proxy=https://p.example', '--claude-desktop'])).toBe(false)
    expect(hasConnectionCode(['AT-ABCD-EFGH'])).toBe(true)
    expect(hasConnectionCode(['https://p.example/connect#AT-ABCD-EFGH'])).toBe(true)
  })

  it('without any agent on the machine, says how to get one', async () => {
    await expect(runSetup(env, [], deps())).rejects.toThrow(/no agent is connected on this machine yet/)
  })

  it('with a link: connects, makes the agent active, writes the client config, doctor finds the unfunded vault', async () => {
    const r = await runSetup(env, [await newLink('setup-a', 11_111)], deps())
    a = r.agentId
    expect(r.connected).toBe(true)
    expect(await readActiveAgent(env.dataDir)).toBe(a)
    expect((await stat(join(env.dataDir, ACTIVE_FILE))).mode & 0o777).toBe(0o600)
    expect([r.files.mcpJson.change, r.files.settings.change, r.files.gitignore.change]).toEqual(['created', 'created', 'created'])
    expect(JSON.parse(await readFile(join(env.projectRoot, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { agenttresor: { type: 'http', url: `${base}/mcp` } } })

    expect(r.checks.filter(c => !c.ok).map(c => c.name)).toEqual(['vault funded'])
    const vault = checkNamed(r.checks, 'vault funded')!
    expect(vault.detail).toMatch(/not funded yet/)
    expect(vault.fix).toContain(`${h.url}/vault.html`)
    expect(checkNamed(r.checks, 'agent key registered')?.detail).toMatch(/fingerprint [0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/)
    expect(checkNamed(r.checks, 'service up to date')).toMatchObject({ ok: true })
    expect(output.at(-1)).toBe('Open a NEW Claude Code session in this folder.')
    expect(output.join('\n')).not.toMatch(/agt_[0-9a-f]{8}/)
  })

  it('is idempotent: run again (repair, no code), no file changes', async () => {
    const files = ['.mcp.json', '.claude/settings.local.json', '.gitignore'].map(f => join(env.projectRoot, f)).concat(join(env.dataDir, ACTIVE_FILE))
    const before = await snapshot(files)
    await new Promise(resolve => setTimeout(resolve, 20))
    const r = await runSetup(env, [], deps())
    expect(r).toMatchObject({ agentId: a, connected: false })
    expect([r.files.mcpJson.change, r.files.settings.change, r.files.gitignore.change]).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(await snapshot(files)).toEqual(before)
  })

  it('a second agent does not take over; /mcp follows the active one and switching does not touch .mcp.json', async () => {
    const r = await runSetup(env, [await newLink('setup-b', 22_222)], deps())
    b = r.agentId
    expect(await readActiveAgent(env.dataDir)).toBe(a)
    expect(r.files.mcpJson.change).toBe('unchanged')

    const budget = async (path: string): Promise<number> => (await (await fetch(`${base}${path}`)).json() as any).rules.dailyBudgetSats
    expect(await budget('/v1/budget')).toBe(11_111)
    const mcpBefore = await snapshot([join(env.projectRoot, '.mcp.json')])

    await setActiveAgent(env.dataDir, b) // what npm run agents use <id> does
    expect(await budget('/v1/budget')).toBe(22_222)
    // MCP at the stable address now speaks for b.
    const mcp = new Client({ name: 'test', version: '1' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
    const key = await mcp.callTool({ name: 'show_agent_key', arguments: {} }) as any
    expect(key.content.map((c: any) => c.text).join('\n')).toContain(await publicKeyOf(b))
    await mcp.close()
    // Per-agent addresses keep working.
    expect(await budget(`/agents/${a}/v1/budget`)).toBe(11_111)
    expect(await snapshot([join(env.projectRoot, '.mcp.json')])).toEqual(mcpBefore)
    await setActiveAgent(env.dataDir, a)
  })

  it('/mcp without an active agent answers 404 with the fix; setup without a code picks the most recent agent', async () => {
    await unlink(join(env.dataDir, ACTIVE_FILE))
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).toMatch(/npm run agents use/)

    // a connected first; make that unambiguous whatever the clock did.
    const old = new Date(Date.now() - 60_000)
    await utimes(join(profileDir(env.dataDir, a), AGENT_CONFIG_FILE), old, old)
    const r = await runSetup(env, [], deps())
    expect(r.agentId).toBe(b)
    expect(output).toContain(`Made ${b} the active agent (served at ${base}/mcp).`)
    expect(await chooseActiveIfNone(env.dataDir)).toEqual({ agentId: b, chosen: false })
  })

  it('repair restarts a service that runs older code', async () => {
    let running = V1
    let restarts = 0
    const r = await runSetup(env, [], deps({
      health: async () => ({ ok: true, pid: 1, version: running }),
      diskVersion: async () => V2,
      restart: async () => { restarts++; running = V2 }
    }))
    expect(restarts).toBe(1)
    expect(output.some(l => l.startsWith('Agent service was stale') && l.includes('restarted it'))).toBe(true)
    expect(checkNamed(r.checks, 'service up to date')).toMatchObject({ ok: true })
  })
})

describe('npm run doctor', () => {
  const doctor = async (health: () => Promise<Health | undefined>, restart: () => Promise<void>): Promise<Check[]> =>
    await runDoctor({ env, health, diskVersion: async () => V2, restart })

  it('reports a stale service and restarts it; says how to fix it if the restart does not help', async () => {
    let running: CodeVersion | undefined // a service from before /health had a version
    const checks = await doctor(async () => ({ ok: true, pid: 7, version: running }), async () => { running = V2 })
    const c = checkNamed(checks, 'service up to date')!
    expect(c).toMatchObject({ ok: true, detail: expect.stringMatching(/^stale: it runs an unknown \(older\) version, the code on disk is 0\.1\.0 \(bbbbbbbbbbbb\)/), fixed: expect.stringMatching(/restarted it/) })

    const stuck = checkNamed(await doctor(async () => ({ ok: true, pid: 7, version: V1 }), async () => {}), 'service up to date')!
    expect(stuck).toMatchObject({ ok: false, fix: 'npm run agent:stop && npm run agent:start' })
    expect(stuck.detail).toMatch(/stale: it runs 0\.1\.0 \(aaaaaaaaaaaa\)/)

    const down = await doctor(async () => undefined, async () => {})
    expect(checkNamed(down, 'service running')).toMatchObject({ ok: false, fix: expect.stringContaining('npm run setup') })
    expect(checkNamed(down, 'service up to date')).toBeUndefined()
  })

  it('reports the unfunded vault, then the funded one and its version', async () => {
    const health = async (): Promise<Health> => ({ ok: true, pid: 7, version: V2 })
    const active = (await readActiveAgent(env.dataDir))!
    expect(checkNamed(await doctor(health, async () => {}), 'vault funded')).toMatchObject({ ok: false, detail: expect.stringMatching(/not funded yet/) })

    await fundVault(h.company, h.url, ADMIN_TOKEN, active, 5_000, fingerprint(await publicKeyOf(active)))
    const checks = await doctor(health, async () => {})
    expect(checkNamed(checks, 'vault funded')).toMatchObject({ ok: true, detail: '5000 sats, v1' })
    expect(checks.every(c => c.ok)).toBe(true)
  })

  it('reports wrong client config with the fix', async () => {
    const path = join(env.projectRoot, '.mcp.json')
    const good = await readFile(path, 'utf8')
    await writeFile(path, JSON.stringify({ mcpServers: { agenttresor: { type: 'http', url: 'http://127.0.0.1:5070/agents/A-OLD/mcp' } } }))
    const checks = await doctor(async () => ({ ok: true, pid: 7, version: V2 }), async () => {})
    expect(checkNamed(checks, '.mcp.json')).toMatchObject({ ok: false, fix: 'npm run setup' })
    expect(await readFile(path, 'utf8')).not.toBe(good) // doctor only checks
    await writeFile(path, good)
  })

  it('the Claude Desktop bridge relays stdio to the active agent\'s /mcp', async () => {
    const entry = claudeDesktopEntry(process.cwd(), Number(new URL(base).port))
    const client = new Client({ name: 'claude-desktop-test', version: '1' })
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...entry.env, PATH: process.env.PATH ?? '' }, stderr: 'pipe' }))
    const tools = (await client.listTools()).tools.map(t => t.name)
    expect(tools).toContain('pay_and_fetch')
    const key = await client.callTool({ name: 'show_agent_key', arguments: {} }) as any
    expect(key.content.map((c: any) => c.text).join('\n')).toContain(await publicKeyOf((await readActiveAgent(env.dataDir))!))
    await client.close()
  })

  it('/health reports the code version the service started with', async () => {
    expect(await serviceHealth(Number(new URL(base).port))).toMatchObject({ ok: true, version: V1 })
  })
})
