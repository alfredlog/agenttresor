/**
 * The local agent service: several agent profiles served side by side over
 * HTTP (MCP and the plain API), the loopback / tunnel-secret access rules,
 * the single-instance lock and the migration of the single-agent files.
 * Mock chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Wallet } from '@bsv/wallet-toolbox'
import { AGENT_CONFIG_FILE } from '../src/agent/config'
import { connectAgent, parseConnectArgs } from '../src/agent/connect'
import { AGENT_KEY_FILE } from '../src/agent/keys'
import { listProfiles, migrateLegacyProfile, rotateTunnelSecret, TUNNEL_SECRET_FILE } from '../src/agent/profiles'
import { approveAndFund, fundVault } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { decideAccess } from '../src/service/access'
import { createAgentServiceApp } from '../src/service/app'
import { acquirePidLock, AlreadyRunningError, startService } from '../src/service/control'
import { mcpJsonFor } from '../src/service/env'
import { buildPlist, LAUNCHD_LABEL } from '../src/service/launchd'
import { AgentRegistry } from '../src/service/registry'
import { capabilityUrl } from '../src/service/tunnel'
import { fingerprint } from '../src/shared/fingerprint'
import { ADMIN_TOKEN, createProxyHarness, type ProxyHarness } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string, merchantHost: string
let tmp: string
let dataDir: string
let service: Server
let base: string
const agents: Record<'a' | 'b', { id: string, dir: string, fingerprint: string }> = {} as any

const rules = (dailyBudgetSats: number): object => ({ allowedHosts: [merchantHost], maxPerPaymentSats: 10_000, dailyBudgetSats, approvalThresholdSats: 1_000 })
const TUNNEL = { 'X-Forwarded-For': '203.0.113.7', 'Cf-Connecting-Ip': '203.0.113.7' }
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const textOf = (res: any): string => res.content.map((c: any) => c.text).join('\n')

/** A raw MCP initialize request; returns the HTTP status. */
const initialize = async (path: string, headers: Record<string, string> = {}): Promise<number> =>
  (await fetch(`${base}${path}`, { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(INIT) })).status

async function mcpClient (path: string, headers: Record<string, string> = {}): Promise<Client> {
  const mcp = new Client({ name: 'test-model', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers } }))
  return mcp
}

async function api (path: string, init: { method?: string, body?: unknown, headers?: Record<string, string> } = {}): Promise<{ status: number, body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function connectNew (name: string, dailyBudgetSats: number): Promise<{ id: string, dir: string, fingerprint: string }> {
  const created = (await h.admin('/admin/agents', { method: 'POST', body: { name, rules: rules(dailyBudgetSats) } })).body
  const r = await connectAgent(parseConnectArgs([created.connectUrl], {}), dataDir)
  return { id: r.agentId, dir: r.profileDir, fingerprint: r.fingerprint }
}

async function listen (app: ReturnType<typeof createAgentServiceApp>): Promise<{ server: Server, url: string }> {
  return await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => { resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }) })
  })
}

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
  merchantHost = new URL(merchant).host
  tmp = await mkdtemp(join(tmpdir(), 'agenttresor-service-'))
  dataDir = join(tmp, 'mcp-data')

  agents.a = await connectNew('service-a', 40_000)
  agents.b = await connectNew('service-b', 30_000)
  await fundVault(h.company, h.url, ADMIN_TOKEN, agents.a.id, 10_000, agents.a.fingerprint)

  const registry = new AgentRegistry(dataDir)
  ;({ server: service, url: base } = await listen(createAgentServiceApp({ registry })))
})
afterAll(async () => {
  await new Promise(resolve => service?.close(resolve))
  await h?.close()
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true })
})

describe('profiles', () => {
  it('each agent has its own directory (0700) and its own key (0600)', async () => {
    for (const a of [agents.a, agents.b]) {
      expect(a.dir).toBe(join(dataDir, 'agents', a.id))
      expect((await stat(a.dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(a.dir, AGENT_KEY_FILE))).mode & 0o777).toBe(0o600)
      expect((await stat(join(a.dir, AGENT_CONFIG_FILE))).mode & 0o777).toBe(0o600)
    }
    const keyA = JSON.parse(await readFile(join(agents.a.dir, AGENT_KEY_FILE), 'utf8'))
    const keyB = JSON.parse(await readFile(join(agents.b.dir, AGENT_KEY_FILE), 'utf8'))
    expect(keyA.privateKey).not.toBe(keyB.privateKey)
    expect(agents.a.fingerprint).not.toBe(agents.b.fingerprint)

    const listed = await listProfiles(dataDir)
    expect(listed.map(p => [p.agentId, p.config?.proxyUrl, p.fingerprint]).sort()).toEqual(
      [[agents.a.id, h.url, agents.a.fingerprint], [agents.b.id, h.url, agents.b.fingerprint]].sort())
  })
})

describe('two agents served side by side', () => {
  it('each MCP endpoint uses its own key and its own proxy account', async () => {
    for (const [a, daily] of [[agents.a, 40_000], [agents.b, 30_000]] as const) {
      const mcp = await mcpClient(`/agents/${a.id}/mcp`)
      expect((await mcp.listTools()).tools).toHaveLength(6)
      expect(textOf(await mcp.callTool({ name: 'show_agent_key', arguments: {} }))).toContain(a.fingerprint)
      expect(textOf(await mcp.callTool({ name: 'check_budget', arguments: {} }))).toContain(`of ${daily} sats`)
      await mcp.close()
    }
  })

  it('an agent connected while the service runs is served without a restart', async () => {
    const c = await connectNew('service-c', 20_000)
    const mcp = await mcpClient(`/agents/${c.id}/mcp`)
    expect(textOf(await mcp.callTool({ name: 'show_agent_key', arguments: {} }))).toContain(c.fingerprint)
    await mcp.close()
    await rm(c.dir, { recursive: true })
  })

  it('an unknown agent is a 404 locally', async () => {
    expect(await initialize('/agents/A-00000000/mcp')).toBe(404)
    expect((await api('/agents/A-00000000/v1/budget')).status).toBe(404)
    expect((await api('/agents/..%2F..%2Fetc/v1/budget')).status).toBe(404)
  })
})

describe('loopback access', () => {
  it('works without a token', async () => {
    expect(await initialize(`/agents/${agents.a.id}/mcp`)).toBe(200)
    expect((await api(`/agents/${agents.a.id}/v1/budget`)).status).toBe(200)
  })

  it('refuses a request with an Origin header (a web page): 403', async () => {
    expect(await initialize(`/agents/${agents.a.id}/mcp`, { Origin: 'https://evil.example' })).toBe(403)
    expect((await api(`/agents/${agents.a.id}/v1/budget`, { headers: { Origin: 'http://127.0.0.1:5070' } })).status).toBe(403)
  })

  it('keeps the SDK Host check (DNS rebinding): 403', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/agents/${agents.a.id}/v1/budget`, { headers: { Host: 'evil.example:5070' } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('/health answers locally, not through a tunnel', async () => {
    expect((await api('/health')).body).toMatchObject({ ok: true, pid: process.pid })
    expect((await api('/health', { headers: TUNNEL })).status).toBe(401)
  })
})

describe('through a tunnel', () => {
  let secretA: string
  let secretB: string
  beforeAll(async () => {
    secretA = await rotateTunnelSecret(agents.a.dir)
    secretB = await rotateTunnelSecret(agents.b.dir)
  })

  it('stores the secret 0600: 32 random bytes, base64url', async () => {
    expect(secretA).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await stat(join(agents.a.dir, TUNNEL_SECRET_FILE))).mode & 0o777).toBe(0o600)
    expect(capabilityUrl('https://abc.trycloudflare.com', agents.a.id, secretA)).toBe(`https://abc.trycloudflare.com/agents/${agents.a.id}/s/${secretA}/mcp`)
  })

  it('without the secret: 401', async () => {
    expect(await initialize(`/agents/${agents.a.id}/mcp`, TUNNEL)).toBe(401)
    expect(await initialize(`/agents/${agents.a.id}/mcp`, { 'X-Forwarded-For': '203.0.113.7' })).toBe(401)
    expect(await initialize(`/agents/${agents.a.id}/mcp`, { 'Cf-Connecting-Ip': '203.0.113.7' })).toBe(401)
    expect((await api(`/agents/${agents.a.id}/v1/budget`, { headers: TUNNEL })).status).toBe(401)
    // Not even which agents exist.
    expect(await initialize('/agents/A-00000000/mcp', TUNNEL)).toBe(401)
  })

  it('with the secret in the path or as a Bearer token: works', async () => {
    const viaPath = await mcpClient(`/agents/${agents.a.id}/s/${secretA}/mcp`, TUNNEL)
    expect(textOf(await viaPath.callTool({ name: 'show_agent_key', arguments: {} }))).toContain(agents.a.fingerprint)
    await viaPath.close()
    const viaBearer = await mcpClient(`/agents/${agents.a.id}/mcp`, { ...TUNNEL, Authorization: `Bearer ${secretA}` })
    expect((await viaBearer.listTools()).tools).toHaveLength(6)
    await viaBearer.close()
    expect((await api(`/agents/${agents.a.id}/s/${secretA}/v1/budget`, { headers: TUNNEL })).status).toBe(200)
  })

  it('a wrong secret, or another agent\'s secret: 401', async () => {
    expect(await initialize(`/agents/${agents.a.id}/s/${secretA.slice(0, -1)}x/mcp`, TUNNEL)).toBe(401)
    expect(await initialize(`/agents/${agents.a.id}/s/${secretB}/mcp`, TUNNEL)).toBe(401)
    expect(await initialize(`/agents/${agents.a.id}/mcp`, { ...TUNNEL, Authorization: `Bearer ${secretB}` })).toBe(401)
    // A wrong secret in the path is refused even from loopback.
    expect(await initialize(`/agents/${agents.a.id}/s/wrong/mcp`)).toBe(401)
  })

  it('revoking rotates the secret: the old link stops working at once', async () => {
    const old = secretA
    secretA = await rotateTunnelSecret(agents.a.dir)
    expect(await initialize(`/agents/${agents.a.id}/s/${old}/mcp`, TUNNEL)).toBe(401)
    expect(await initialize(`/agents/${agents.a.id}/s/${secretA}/mcp`, TUNNEL)).toBe(200)
  })

  it('an agent without a secret cannot be reached through the tunnel at all', async () => {
    const c = await connectNew('no-tunnel', 10_000)
    expect(await initialize(`/agents/${c.id}/mcp`, TUNNEL)).toBe(401)
    expect(await initialize(`/agents/${c.id}/s/${secretA}/mcp`, TUNNEL)).toBe(401)
    await rm(c.dir, { recursive: true })
  })
})

describe('plain HTTP API', () => {
  const path = (p: string): string => `/agents/${agents.a.id}/v1${p}`

  it('GET /v1/budget: the check_budget result', async () => {
    const r = await api(path('/budget'))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ rules: { dailyBudgetSats: 40_000 }, vault: { status: 'open', satoshis: 10_000 } })
  })

  it('POST /v1/price: the merchant\'s own price', async () => {
    expect((await api(path('/price'), { body: { url: `${merchant}/api/report` } })).body).toMatchObject({ status: 'priced', satoshis: REPORT_PRICE_SATS })
    expect((await api(path('/price'), { body: { url: 'not a url' } })).status).toBe(400)
  })

  it('POST /v1/pay: pays with the agent\'s signature, never above maxSats', async () => {
    const refused = await api(path('/pay'), { body: { url: `${merchant}/api/report`, purpose: 'Market report', maxSats: REPORT_PRICE_SATS - 1 } })
    expect(refused.body).toMatchObject({ status: 'denied', deniedBy: 'agent' })

    const paid = await api(path('/pay'), { body: { url: `${merchant}/api/report`, purpose: 'Market report', maxSats: REPORT_PRICE_SATS } })
    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'paid', satoshis: REPORT_PRICE_SATS, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(paid.body.response.status).toBe(200)

    expect((await api(path('/pay'), { body: { url: `${merchant}/api/report`, maxSats: 600 } })).status).toBe(400) // no purpose
  })

  it('GET /v1/requests/:id: pending, then paid once the company approves', async () => {
    const pending = await api(path('/pay'), {
      body: { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel for the trip', maxSats: 5_000 }
    })
    expect(pending.body).toMatchObject({ status: 'pending', satoshis: ROOM_RATES_SATS.standard })
    const { requestId } = pending.body
    expect((await api(path(`/requests/${requestId}`))).body).toMatchObject({ status: 'pending', requestId })

    await approveAndFund(h.company, h.url, ADMIN_TOKEN, requestId, agents.a.fingerprint)
    const done = await api(path(`/requests/${requestId}`))
    expect(done.body).toMatchObject({ status: 'paid', requestId, satoshis: ROOM_RATES_SATS.standard })
    expect((await api(path('/requests/not-an-id'))).status).toBe(400)
  })

  it('a disconnected agent answers 503', async () => {
    const dir = join(dataDir, 'agents', 'A-REVOKED')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, AGENT_CONFIG_FILE), JSON.stringify({ proxyUrl: h.url, agentId: 'A-REVOKED', apiKey: `agt_${'0'.repeat(64)}`, merchants: [] }))
    const r = await api('/agents/A-REVOKED/v1/budget')
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/revoked/)
    await rm(dir, { recursive: true })
  })
})

describe('listening off loopback', () => {
  it('needs MCP_TOKEN', () => {
    const registry = new AgentRegistry(dataDir)
    expect(() => createAgentServiceApp({ registry, host: '0.0.0.0' })).toThrow(/MCP_TOKEN must be set/)
    expect(() => createAgentServiceApp({ registry, host: '0.0.0.0', token: 'short' })).toThrow(/at least 16/)
  })

  it('then every request needs the token (or the agent\'s secret)', async () => {
    const TOKEN = 'test-mcp-token-0123456789'
    const { server, url } = await listen(createAgentServiceApp({ registry: new AgentRegistry(dataDir), host: '0.0.0.0', token: TOKEN }))
    try {
      const status = async (headers: Record<string, string>): Promise<number> =>
        (await fetch(`${url}/agents/${agents.b.id}/v1/budget`, { headers })).status
      expect(await status({})).toBe(401)
      expect(await status({ Authorization: 'Bearer wrong-token-0123456789' })).toBe(401)
      expect(await status({ Authorization: `Bearer ${TOKEN}` })).toBe(200)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('access rules for a non-loopback client', () => {
    const base = { loopbackBind: true, forwarded: false, loopbackClient: false, agentSecret: 'secret-1' }
    expect(decideAccess(base)).toMatchObject({ ok: false, status: 401 })
    expect(decideAccess({ ...base, bearer: 'secret-1' })).toMatchObject({ ok: true, via: 'secret' })
    expect(decideAccess({ ...base, loopbackBind: false, token: 'token-0123456789abc', bearer: 'token-0123456789abc' })).toMatchObject({ ok: true, via: 'token' })
    // Through a tunnel, MCP_TOKEN does not count: only the agent's own secret.
    expect(decideAccess({ ...base, loopbackBind: false, forwarded: true, token: 'token-0123456789abc', bearer: 'token-0123456789abc' })).toMatchObject({ ok: false, status: 401 })
  })
})

describe('single instance', () => {
  it('a second start is refused while the first runs', async () => {
    const dir = await mkdtemp(join(tmp, 'lock-'))
    const release = await acquirePidLock(dir)
    // Another process trying to start: the lock names a live process (this one).
    await expect(acquirePidLock(dir, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError)
    await expect(startService({ projectRoot: process.cwd(), dataDir: dir }, { port: 1 })).rejects.toThrow(/already running/)
    await release()
    const again = await acquirePidLock(dir, process.pid + 1)
    await again()
  })

  it('a stale pid file (its process is gone) does not block a start', async () => {
    const dir = await mkdtemp(join(tmp, 'stale-'))
    await writeFile(join(dir, 'agent.pid'), '999999\n')
    const release = await acquirePidLock(dir)
    expect((await readFile(join(dir, 'agent.pid'), 'utf8')).trim()).toBe(String(process.pid))
    await release()
  })
})

describe('migration of the single-agent files', () => {
  const legacyConfig = { proxyUrl: 'https://proxy.example', agentId: 'A-0123ABCD', apiKey: `agt_${'1'.repeat(64)}`, merchants: [], connectedAt: '2026-10-01T00:00:00.000Z' }
  const legacyKey = { privateKey: 'aa'.repeat(32), publicKey: '02' + 'bb'.repeat(32), createdAt: '2026-10-01T00:00:00.000Z' }

  it('moves agent-config.json and agent-key.json into the agent\'s profile', async () => {
    const dir = await mkdtemp(join(tmp, 'legacy-'))
    const configText = JSON.stringify(legacyConfig)
    const keyText = JSON.stringify(legacyKey)
    await writeFile(join(dir, AGENT_CONFIG_FILE), configText, { mode: 0o600 })
    await writeFile(join(dir, AGENT_KEY_FILE), keyText, { mode: 0o644 })

    expect(await migrateLegacyProfile(dir)).toMatchObject({ status: 'migrated', agentId: legacyConfig.agentId })
    const profile = join(dir, 'agents', legacyConfig.agentId)
    expect(await readFile(join(profile, AGENT_CONFIG_FILE), 'utf8')).toBe(configText)
    expect(await readFile(join(profile, AGENT_KEY_FILE), 'utf8')).toBe(keyText)
    expect((await stat(profile)).mode & 0o777).toBe(0o700)
    expect((await stat(join(profile, AGENT_KEY_FILE))).mode & 0o777).toBe(0o600)
    // Moved, not copied: the key exists in one place only.
    await expect(stat(join(dir, AGENT_KEY_FILE))).rejects.toThrow()
    await expect(stat(join(dir, AGENT_CONFIG_FILE))).rejects.toThrow()

    expect(await migrateLegacyProfile(dir)).toEqual({ status: 'none' })
    const [p] = await listProfiles(dir)
    expect(p).toMatchObject({ agentId: legacyConfig.agentId, fingerprint: fingerprint(legacyKey.publicKey) })
  })

  it('never overwrites an existing profile', async () => {
    const dir = await mkdtemp(join(tmp, 'legacy-'))
    await mkdir(join(dir, 'agents', legacyConfig.agentId), { recursive: true })
    await writeFile(join(dir, AGENT_CONFIG_FILE), JSON.stringify(legacyConfig))
    await writeFile(join(dir, AGENT_KEY_FILE), JSON.stringify(legacyKey))
    expect(await migrateLegacyProfile(dir)).toMatchObject({ status: 'skipped' })
    expect(JSON.parse(await readFile(join(dir, AGENT_KEY_FILE), 'utf8'))).toEqual(legacyKey)
  })

  it('leaves a key without a config where it is', async () => {
    const dir = await mkdtemp(join(tmp, 'legacy-'))
    await writeFile(join(dir, AGENT_KEY_FILE), JSON.stringify(legacyKey))
    expect(await migrateLegacyProfile(dir)).toMatchObject({ status: 'skipped' })
    expect(JSON.parse(await readFile(join(dir, AGENT_KEY_FILE), 'utf8'))).toEqual(legacyKey)
  })
})

describe('service files', () => {
  it('the launchd plist runs the service as the user, with no secrets', () => {
    const plist = buildPlist({ projectRoot: '/Users/me/agenttresor', dataDir: '/Users/me/agenttresor/mcp-data' })
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).toContain('<string>/Users/me/agenttresor/src/service/main.ts</string>')
    expect(plist).toContain('<string>/Users/me/agenttresor/mcp-data/agent.log</string>')
    expect(plist).not.toMatch(/UserName|agt_|MCP_TOKEN/)
  })

  it('.mcp.json points Claude Code at one agent over HTTP', async () => {
    expect(JSON.parse(mcpJsonFor(5070, 'A-0123ABCD'))).toEqual({ mcpServers: { agenttresor: { type: 'http', url: 'http://127.0.0.1:5070/agents/A-0123ABCD/mcp' } } })
    const example = JSON.parse(await readFile('.mcp.json.example', 'utf8'))
    expect(example.mcpServers.agenttresor).toEqual({ type: 'http', url: 'http://127.0.0.1:5070/agents/<agentId>/mcp' })
  })
})
