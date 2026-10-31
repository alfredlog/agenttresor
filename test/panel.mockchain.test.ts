/**
 * The setup command on the dashboard and the connect page, and the local agent
 * panel (http://127.0.0.1:<port>/): it lists the profiles and activates one;
 * its API refuses other Origins, a missing or wrong CSRF token and anything
 * through the tunnel; no answer carries a secret. Mock chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectAgent, parseConnectArgs } from '../src/agent/connect'
import { AGENT_KEY_FILE } from '../src/agent/keys'
import { readActiveAgent, rotateTunnelSecret, setActiveAgent } from '../src/agent/profiles'
import { fundVault } from '../src/company/vault-client'
import { createAgentServiceApp } from '../src/service/app'
import { runDoctor } from '../src/service/doctor'
import type { ServiceEnv } from '../src/service/env'
import { AgentRegistry } from '../src/service/registry'
import { setupCommand } from '../src/shared/setup-command'
import { ADMIN_TOKEN, createProxyHarness, type ProxyHarness } from './helpers/proxy'

const TUNNEL = { 'X-Forwarded-For': '203.0.113.7', 'Cf-Connecting-Ip': '203.0.113.7' }
const VERSION = { package: '0.1.0', commit: 'c'.repeat(40), id: `0.1.0+${'c'.repeat(40)}` }

let h: ProxyHarness
let tmp: string
let env: ServiceEnv
let server: Server
let port: number
let self: string
const agents: Record<'a' | 'b', { id: string, dir: string, fingerprint: string }> = {} as any
/** Every secret on this machine: the panel must never answer with one of them. */
const secrets: string[] = []
/** Every panel answer the tests saw. */
const seen: string[] = []

interface Raw { status: number, headers: Record<string, string | string[] | undefined>, text: string, body: any }

/** A raw request, so the test controls Host and Origin like a browser or a tunnel would. */
async function raw (path: string, opts: { method?: string, headers?: Record<string, string> } = {}): Promise<Raw> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(`${self}${path}`, { method: opts.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => {
        seen.push(text)
        let body: any = null
        try { body = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** The page, and the CSRF token embedded in it. */
async function page (): Promise<{ res: Raw, token: string }> {
  const res = await raw('/')
  const token = /<meta name="panel-token" content="([^"]+)">/.exec(res.text)?.[1]
  if (token === undefined) throw new Error(`no token in the page (${res.status})`)
  return { res, token }
}

const panelApi = async (path: string, token: string | undefined, opts: { method?: string, headers?: Record<string, string> } = {}): Promise<Raw> =>
  await raw(path, { ...opts, headers: { ...(token === undefined ? {} : { 'X-Panel-Token': token }), ...opts.headers } })

async function connectNew (name: string): Promise<{ id: string, dir: string, fingerprint: string }> {
  const created = (await h.admin('/admin/agents', { method: 'POST', body: { name, rules: { allowedHosts: [], maxPerPaymentSats: 2_000, dailyBudgetSats: 9_000, approvalThresholdSats: 1_000 } } })).body
  const r = await connectAgent(parseConnectArgs([created.connectUrl], {}), env.dataDir)
  return { id: r.agentId, dir: r.profileDir, fingerprint: r.fingerprint }
}

beforeAll(async () => {
  // New vaults are v2, so the panel shows the covenant's caps.
  h = await createProxyHarness({ app: { vaultCovenant: true } })
  tmp = await mkdtemp(join(tmpdir(), 'agenttresor-panel-'))
  env = { projectRoot: join(tmp, 'project'), dataDir: join(tmp, 'mcp-data'), port: 0, host: '127.0.0.1' }
  await mkdir(env.projectRoot)

  agents.a = await connectNew('panel-alpha')
  agents.b = await connectNew('panel-beta')
  await fundVault(h.company, h.url, ADMIN_TOKEN, agents.a.id, 5_000, agents.a.fingerprint)
  await setActiveAgent(env.dataDir, agents.a.id)
  const tunnelSecret = await rotateTunnelSecret(agents.a.dir)

  for (const a of [agents.a, agents.b]) {
    const config = JSON.parse(await readFile(join(a.dir, 'agent-config.json'), 'utf8'))
    const key = JSON.parse(await readFile(join(a.dir, AGENT_KEY_FILE), 'utf8'))
    secrets.push(config.apiKey, key.privateKey)
  }
  secrets.push(tunnelSecret)
  expect(secrets.every(s => typeof s === 'string' && s.length >= 32)).toBe(true)

  const app = createAgentServiceApp({
    registry: new AgentRegistry(env.dataDir),
    version: VERSION,
    panel: {
      doctor: async () => await runDoctor({
        env: { ...env, port },
        health: async () => ({ ok: true, pid: process.pid, version: VERSION }),
        diskVersion: async () => VERSION,
        restart: async () => { throw new Error('no restart expected') }
      })
    }
  })
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { resolve() }) })
  port = (server.address() as AddressInfo).port
  self = `http://127.0.0.1:${port}`
})
afterAll(async () => {
  await new Promise(resolve => server?.close(resolve))
  await h?.close()
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true })
})

describe('the setup command on the dashboard and the connect page', () => {
  it('is npm run setup with the whole link in double quotes', async () => {
    const created = (await h.admin('/admin/agents', { method: 'POST', body: { name: 'cmd-bot' } })).body
    expect(setupCommand(created.connectUrl)).toBe(`npm run setup "${h.url}/connect#${created.connectCode as string}"`)
    // Nothing that would expand or end the quoted string in a shell.
    for (const bad of ['https://x.example/connect#AT-1"; rm -rf ~ #', 'https://x.example/$(id)', 'https://x.example/`id`', 'https://x.example/!!', 'file:///etc/passwd']) {
      expect(() => setupCommand(bad)).toThrow(/cannot|not a connection link/)
    }
  })

  it('both pages show it, and never npm run connect', async () => {
    for (const path of ['/', '/connect']) {
      const res = await fetch(`${h.url}${path}`)
      const html = await res.text()
      expect(res.status).toBe(200)
      expect(html).toContain("import { setupCommand } from './setup-command.js'")
      expect(html).not.toContain('npm run connect')
    }
    expect(await (await fetch(`${h.url}/`)).text()).toContain("$('code-command').value = setupCommand(issued.connectUrl)")
    expect(await (await fetch(`${h.url}/connect`)).text()).toContain('setupCommand(`${location.origin}/connect#${code.toUpperCase()}`)')
  })
})

describe('the local agent panel', () => {
  it('serves the page locally, with its token, framing and scripts locked down', async () => {
    const { res, token } = await page()
    expect(res.status).toBe(200)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/)
    expect(res.headers['cache-control']).toBe('no-store')
    // localhost is sent to the panel's one address, where the browser's Origin is the expected one.
    const viaLocalhost = await raw('/', { headers: { Host: `localhost:${port}` } })
    expect([viaLocalhost.status, viaLocalhost.headers.location]).toEqual([302, `${self}/`])
  })

  it('lists the profiles: name, proxy, fingerprint, vault and version, which one is active', async () => {
    const { token } = await page()
    const res = await panelApi('/panel/api/agents', token, { headers: { Origin: self } })
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.agents as any[]).map(a => [a.agentId, a]))
    expect(Object.keys(byId).sort()).toEqual([agents.a.id, agents.b.id].sort())
    expect(byId[agents.a.id]).toMatchObject({
      name: 'panel-alpha',
      proxyUrl: h.url,
      fingerprint: agents.a.fingerprint,
      active: true,
      proxy: 'reachable',
      vault: { status: 'open', satoshis: 5_000, version: 'v2', caps: { maxSats: 2_000, maxFeeSats: expect.any(Number) } },
      remainingTodaySats: 9_000
    })
    expect(byId[agents.b.id]).toMatchObject({ name: 'panel-beta', fingerprint: agents.b.fingerprint, active: false, proxy: 'reachable' })
    expect(byId[agents.b.id].vault.status).not.toBe('open')
  })

  it('shows the doctor checks with their fixes', async () => {
    const { token } = await page()
    const res = await panelApi('/panel/api/doctor', token)
    expect(res.status).toBe(200)
    const checks = res.body.checks as any[]
    expect(checks.find(c => c.name === 'active agent')).toMatchObject({ ok: true, detail: expect.stringContaining(agents.a.id) })
    expect(checks.find(c => c.name === '.mcp.json')).toMatchObject({ ok: false, fix: 'npm run setup' })
  })

  it('activates an agent, like npm run agents use', async () => {
    const { token } = await page()
    const res = await panelApi(`/panel/api/agents/${agents.b.id}/activate`, token, { method: 'POST', headers: { Origin: self } })
    expect([res.status, res.body]).toEqual([200, { active: agents.b.id }])
    expect(await readActiveAgent(env.dataDir)).toBe(agents.b.id)
    const listed = (await panelApi('/panel/api/agents', token)).body.agents as any[]
    expect(listed.filter(a => a.active).map(a => a.agentId)).toEqual([agents.b.id])

    expect((await panelApi('/panel/api/agents/A-00000000/activate', token, { method: 'POST' })).status).toBe(404)
    expect((await panelApi('/panel/api/agents/..%2F..%2Fetc/activate', token, { method: 'POST' })).status).toBe(400)
    await setActiveAgent(env.dataDir, agents.a.id)
  })

  it('refuses another Origin, even with the right token', async () => {
    const { token } = await page()
    for (const origin of ['http://evil.example', `http://localhost:${port}`, `https://127.0.0.1:${port}`, 'http://127.0.0.1:1', 'null']) {
      expect((await panelApi('/panel/api/agents', token, { headers: { Origin: origin } })).status).toBe(403)
      expect((await panelApi(`/panel/api/agents/${agents.b.id}/activate`, token, { method: 'POST', headers: { Origin: origin } })).status).toBe(403)
      expect((await raw('/', { headers: { Origin: origin } })).status).toBe(403)
    }
    expect(await readActiveAgent(env.dataDir)).toBe(agents.a.id)
  })

  it('refuses a missing or wrong CSRF token, with or without the right Origin', async () => {
    const { token } = await page()
    const wrong = [undefined, '', 'x', token.slice(0, -1), `${token}x`, token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()]
    for (const t of wrong) {
      for (const headers of [{}, { Origin: self }] as Array<Record<string, string>>) {
        expect((await panelApi('/panel/api/agents', t, { headers })).status).toBe(403)
        expect((await panelApi('/panel/api/doctor', t, { headers })).status).toBe(403)
        expect((await panelApi(`/panel/api/agents/${agents.b.id}/activate`, t, { method: 'POST', headers })).status).toBe(403)
      }
    }
    // A token from another start of the service does not work either.
    const other = createAgentServiceApp({ registry: new AgentRegistry(env.dataDir) })
    const otherServer = await new Promise<Server>(resolve => { const s = other.listen(0, '127.0.0.1', () => { resolve(s) }) })
    const otherPort = (otherServer.address() as AddressInfo).port
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${otherPort}/panel/api/agents`, { headers: { 'X-Panel-Token': token } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    await new Promise(resolve => otherServer.close(resolve))
    expect(status).toBe(403)
    expect(await readActiveAgent(env.dataDir)).toBe(agents.a.id)
  })

  it('is never reachable through the tunnel or under another Host', async () => {
    const { token } = await page()
    expect((await raw('/', { headers: TUNNEL })).status).toBe(404)
    expect((await panelApi('/panel/api/agents', token, { headers: TUNNEL })).status).toBe(404)
    expect((await panelApi(`/panel/api/agents/${agents.b.id}/activate`, token, { method: 'POST', headers: TUNNEL })).status).toBe(404)
    expect((await panelApi('/panel/api/agents', token, { headers: { Forwarded: 'for=203.0.113.7' } })).status).toBe(404)
    // The tunnel path with a valid agent secret reaches that agent only, never the panel.
    const secret = secrets.at(-1)!
    for (const path of ['', '/', '/panel/api/agents', '/panel/api/doctor']) {
      const res = await panelApi(`/agents/${agents.a.id}/s/${secret}${path}`, token, { headers: TUNNEL })
      expect(res.status).toBe(404)
      expect(res.text).not.toContain('agents"')
    }
    const viaTunnelActivate = await panelApi(`/agents/${agents.a.id}/s/${secret}/panel/api/agents/${agents.b.id}/activate`, token, { method: 'POST', headers: TUNNEL })
    expect(viaTunnelActivate.status).toBe(404)
    // DNS rebinding: a page on another name that resolves to 127.0.0.1.
    expect((await raw('/', { headers: { Host: `evil.example:${port}` } })).status).toBe(421)
    expect((await panelApi('/panel/api/agents', token, { headers: { Host: `evil.example:${port}` } })).status).toBe(421)
    expect(await readActiveAgent(env.dataDir)).toBe(agents.a.id)
  })

  it('no answer carries a key, an agt_ key or a tunnel secret', async () => {
    const { token } = await page()
    await panelApi('/panel/api/agents', token)
    await panelApi('/panel/api/doctor', token)
    expect(seen.length).toBeGreaterThan(40)
    for (const text of seen) {
      for (const s of secrets) expect(text).not.toContain(s)
      expect(text).not.toMatch(/agt_/)
    }
  })
})
