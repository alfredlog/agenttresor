/**
 * Zero-config agent onboarding: a one-time connection code, exchanged once
 * within 10 minutes for the agent's API key and settings. Mock chain.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Wallet } from '@bsv/wallet-toolbox'
import { AGENT_CONFIG_FILE, writeAgentConfig } from '../src/agent/config'
import { connectAgent, parseConnectArgs } from '../src/agent/connect'
import { AGENT_KEY_FILE } from '../src/agent/keys'
import { fundVault } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS } from '../src/merchant/app'
import { NOT_CONNECTED } from '../src/mcp/server'
import { setupAgent } from '../src/mcp/setup'
import { createProxyApp } from '../src/proxy/app'
import { findConnectCode, hashConnectCode, normalizeConnectCode } from '../src/proxy/connect'
import { DashboardNotifier } from '../src/proxy/notifier'
import { fingerprint } from '../src/shared/fingerprint'
import { ADMIN_TOKEN, createProxyHarness, type ProxyHarness } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string, merchantHost: string
let tmp: string

const rules = (hosts?: string[]): object => ({ allowedHosts: hosts ?? [merchantHost], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000 })
const create = async (name: string, hosts?: string[]): Promise<any> => (await h.admin('/admin/agents', { method: 'POST', body: { name, rules: rules(hosts) } })).body
const exchange = async (code: unknown): Promise<{ status: number, body: any }> => await h.call('/v1/connect', undefined, { method: 'POST', body: { code } })
const dir = async (): Promise<string> => await mkdtemp(join(tmp, 'agent-'))

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
  merchantHost = new URL(merchant).host
  tmp = await mkdtemp(join(tmpdir(), 'agenttresor-connect-'))
})
afterAll(async () => {
  await h?.close()
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true })
})

describe('connection codes', () => {
  it('creating an agent returns a one-time code, valid for 10 minutes', async () => {
    const created = await create('code-bot')
    expect(created.connectCode).toMatch(/^AT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(created.connectUrl).toBe(`${h.url}/connect#${created.connectCode}`)
    expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(Date.parse(created.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    // Stored as sha256 only.
    const row = await h.db('connect_codes').where({ agent_id: created.id }).first()
    expect(row.code_hash).toBe(hashConnectCode(created.connectCode))
    expect(JSON.stringify(await h.db('connect_codes').select())).not.toContain(created.connectCode)
  })

  it('works once; a reused, expired, wrong or malformed code gets the same 401', async () => {
    const created = await create('once-bot')
    const first = await exchange(created.connectCode)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ agentId: created.id, apiKey: expect.stringMatching(/^agt_[0-9a-f]{64}$/), proxyUrl: h.url })
    expect((await h.call('/v1/budget', first.body.apiKey)).status).toBe(200)

    const reused = await exchange(created.connectCode)
    const expiring = await create('expired-bot')
    h.clock.offset = 10 * 60_000 + 1
    let expired
    try { expired = await exchange(expiring.connectCode) } finally { h.clock.offset = 0 }
    const wrong = await exchange('AT-0000-0000')
    const malformed = await exchange('not a code')
    for (const r of [reused, expired, wrong, malformed]) {
      expect(r.status).toBe(401)
      expect(r.body).toEqual({ error: 'invalid, expired or already used connection code' })
    }
  })

  it('accepts the code however it is typed', async () => {
    const created = await create('typing-bot')
    const sloppy = created.connectCode.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(normalizeConnectCode(sloppy)).toBe(created.connectCode)
    expect((await exchange(sloppy)).status).toBe(200)
    expect(normalizeConnectCode('AT-UUUU-UUUU')).toBeUndefined() // U is not Crockford base32
  })

  it('compares every active code in constant time, whether or where one matches', () => {
    const candidates = ['AT-AAAA-AAAA', 'AT-BBBB-BBBB', 'AT-CCCC-CCCC', 'AT-DDDD-DDDD'].map(c => ({ codeHash: hashConnectCode(c) }))
    const counts: number[] = []
    for (const code of ['AT-AAAA-AAAA', 'AT-DDDD-DDDD', 'AT-EEEE-EEEE']) {
      let n = 0
      const found = findConnectCode(candidates, hashConnectCode(code), (a, b) => { n++; return a.equals(b) })
      counts.push(n)
      expect(found?.codeHash ?? null).toBe(code === 'AT-EEEE-EEEE' ? null : hashConnectCode(code))
    }
    expect(counts).toEqual([4, 4, 4]) // first, last or no match: the same work
  })

  it('rate-limits the exchange per IP', async () => {
    const app = createProxyApp({
      db: h.db, policyRootKey: h.policyRootKey, chainTracker: h.chain.chainTracker, broadcaster: h.chain.broadcaster,
      notifier: new DashboardNotifier(), adminToken: ADMIN_TOKEN, network: 'test', connectRateLimit: { max: 3, windowMs: 60_000 }
    })
    const server: Server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
    try {
      const url = `http://localhost:${(server.address() as AddressInfo).port}/v1/connect`
      const statuses: number[] = []
      for (let i = 0; i < 4; i++) {
        statuses.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AT-0000-0000' }) })).status)
      }
      expect(statuses).toEqual([401, 401, 401, 429])
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('a new code for an existing agent', () => {
  it('without an open vault, the old API key is revoked at once', async () => {
    const agent = await h.newAgent('reissue-bot', rules())
    expect((await h.call('/v1/budget', agent.apiKey)).status).toBe(200)
    const issued = await h.admin(`/admin/agents/${agent.id}/connect-code`, { method: 'POST' })
    expect(issued.body).toMatchObject({ id: agent.id, oldKeyRevoked: true, connectCode: expect.stringMatching(/^AT-/) })
    expect((await h.call('/v1/budget', agent.apiKey)).status).toBe(401)
    const again = await exchange(issued.body.connectCode)
    expect((await h.call('/v1/budget', again.body.apiKey)).status).toBe(200)
  })

  it('with an open vault, the old key keeps working until the new code is used', async () => {
    const agent = await h.createAgent('busy-bot', rules(), 5_000)
    const first = await h.admin(`/admin/agents/${agent.id}/connect-code`, { method: 'POST' })
    const issued = await h.admin(`/admin/agents/${agent.id}/connect-code`, { method: 'POST' })
    expect(issued.body.oldKeyRevoked).toBe(false)
    expect((await h.call('/v1/budget', agent.key)).status).toBe(200)
    expect((await exchange(first.body.connectCode)).status).toBe(401) // replaced by the newer code
    const next = await exchange(issued.body.connectCode)
    expect((await h.call('/v1/budget', agent.key)).status).toBe(401)
    expect((await h.call('/v1/budget', next.body.apiKey)).body.vault.status).toBe('open')
    expect((await h.admin('/admin/agents/A-NOPE/connect-code', { method: 'POST' })).status).toBe(404)
  })
})

describe('GET /v1/services', () => {
  it('lists only the merchants the agent may pay', async () => {
    const agent = await h.newAgent('services-bot', rules([merchantHost, 'api.example.com']))
    const res = await h.call('/v1/services', agent.apiKey)
    expect(res.body).toEqual({
      merchants: [
        { name: merchantHost, url: merchant, catalogUrl: `${merchant}/api/catalog` },
        { name: 'api.example.com', url: 'https://api.example.com', catalogUrl: 'https://api.example.com/api/catalog' }
      ]
    })
    expect((await h.call('/v1/services', undefined)).status).toBe(401)
  })
})

describe('npm run connect', () => {
  it('reads the code and the proxy URL from the command line', () => {
    const code = 'AT-ABCD-EFGH'
    expect(parseConnectArgs([`https://proxy.example/connect#${code}`], {})).toEqual({ code, proxyUrl: 'https://proxy.example' })
    expect(parseConnectArgs([code, '--proxy', 'https://proxy.example/'], {})).toEqual({ code, proxyUrl: 'https://proxy.example' })
    // `npm run connect <code> --proxy URL` without `--`: npm keeps --proxy and sets npm_config_proxy.
    expect(parseConnectArgs([code], { npm_config_proxy: 'https://proxy.example/' })).toEqual({ code, proxyUrl: 'https://proxy.example' })
    expect(parseConnectArgs([code], { PROXY_URL: 'https://fallback.example' })).toEqual({ code, proxyUrl: 'https://fallback.example' })
    expect(() => parseConnectArgs([code], {})).toThrow(/no proxy URL/)
    expect(() => parseConnectArgs([], { PROXY_URL: 'https://x.example' })).toThrow(/no connection code/)
  })

  it('writes a 0600 config into the agent\'s profile, creates the agent key and registers it', async () => {
    const created = await create('cli-bot')
    const dataDir = await dir()
    const r = await connectAgent(parseConnectArgs([created.connectUrl], {}), dataDir)

    const profile = join(dataDir, 'agents', created.id)
    const configPath = join(profile, AGENT_CONFIG_FILE)
    expect(r).toMatchObject({ agentId: created.id, proxyUrl: h.url, profileDir: profile, configPath, registration: 'registered' })
    expect((await stat(profile)).mode & 0o777).toBe(0o700)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    expect(config).toMatchObject({ proxyUrl: h.url, agentId: created.id, apiKey: expect.stringMatching(/^agt_/), merchants: [{ name: merchantHost }] })
    expect(JSON.stringify(r)).not.toMatch(/agt_/) // what the CLI prints from

    const key = JSON.parse(await readFile(join(profile, AGENT_KEY_FILE), 'utf8'))
    expect((await stat(join(profile, AGENT_KEY_FILE))).mode & 0o777).toBe(0o600)
    expect(r.fingerprint).toBe(fingerprint(key.publicKey))
    expect((await h.db('vaults').where({ agent_id: created.id }).first()).agent_pub).toBe(key.publicKey)
    // Used up.
    await expect(connectAgent(parseConnectArgs([created.connectUrl], {}), await dir())).rejects.toThrow(/refused the code \(401\)/)
  })
})

describe('the MCP server', () => {
  const textOf = (res: any): string => res.content.map((c: any) => c.text).join('\n')

  async function connectMcp (dataDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ mcp: Client, disconnected?: string }> {
    const setup = await setupAgent(dataDir, env)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await setup.createServer().connect(serverSide)
    const mcp = new Client({ name: 'test-model', version: '1.0.0' })
    await mcp.connect(clientSide)
    return { mcp, disconnected: setup.disconnected }
  }

  it('without a config it still starts, and every tool says how to connect', async () => {
    const { mcp, disconnected } = await connectMcp(await dir())
    expect(disconnected).toBe(NOT_CONNECTED)
    expect(NOT_CONNECTED).toBe('Not connected. Ask your admin for a connection code and run: npm run connect <code>')
    const { tools } = await mcp.listTools()
    expect(tools).toHaveLength(6)
    const args: Record<string, Record<string, unknown>> = {
      get_price: { url: `${merchant}/api/report` },
      pay_and_fetch: { url: `${merchant}/api/report`, purpose: 'Report', maxSats: 600 },
      check_request: { requestId: 'R-0000000000' }
    }
    for (const t of tools) {
      const res = await mcp.callTool({ name: t.name, arguments: args[t.name] ?? {} })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toBe(NOT_CONNECTED)
    }
    await mcp.close()
  })

  it('with a revoked key it says so instead of failing to start', async () => {
    const dataDir = await dir()
    await writeAgentConfig(dataDir, { proxyUrl: h.url, agentId: 'A-GONE', apiKey: `agt_${'0'.repeat(64)}`, merchants: [], connectedAt: new Date().toISOString() })
    const { mcp, disconnected } = await connectMcp(dataDir)
    expect(disconnected).toMatch(/^Not connected\. .*revoked/)
    expect(textOf(await mcp.callTool({ name: 'check_budget', arguments: {} }))).toBe(disconnected)
    await mcp.close()
  })

  it('reads the config written by connect; env vars override it', async () => {
    const created = await create('mcp-bot')
    const { profileDir: dataDir } = await connectAgent(parseConnectArgs([created.connectUrl], {}), await dir())
    const { mcp, disconnected } = await connectMcp(dataDir)
    expect(disconnected).toBeUndefined()
    expect(textOf(await mcp.callTool({ name: 'list_services', arguments: {} }))).toContain(`${merchant}/api/report`)
    await mcp.close()

    const overridden = await connectMcp(dataDir, { MERCHANT_URLS: 'http://127.0.0.1:1' })
    expect(textOf(await overridden.mcp.callTool({ name: 'list_services', arguments: {} }))).toContain('http://127.0.0.1:1')
    await overridden.mcp.close()
  })
})

describe('the API key is only ever in the /v1/connect answer', () => {
  it('no other response, log line or audit entry contains it', async () => {
    const realFetch = globalThis.fetch
    const responses: Array<{ url: string, text: string }> = []
    globalThis.fetch = async (input, init) => {
      const res = await realFetch(input, init)
      responses.push({ url: String(input), text: await res.clone().text() })
      return res
    }
    const output: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map(m => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { output.push(a.map(String).join(' ')) }))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { output.push(String(chunk)); return true })

    let apiKey: string
    try {
      // A whole agent life: created, connected, funded, paying, listed, and given a new code.
      const created = (await realAdmin('/admin/agents', { name: 'leak-bot', rules: rules() })) as any
      const r = await connectAgent(parseConnectArgs([created.connectUrl], {}), await dir())
      const dataDir = r.profileDir
      apiKey = JSON.parse(await readFile(join(dataDir, AGENT_CONFIG_FILE), 'utf8')).apiKey
      await fundVault(h.company, h.url, ADMIN_TOKEN, created.id, 5_000, r.fingerprint)

      const setup = await setupAgent(dataDir, {})
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await setup.createServer().connect(serverSide)
      const mcp = new Client({ name: 'test-model', version: '1.0.0' })
      await mcp.connect(clientSide)
      for (const name of ['show_agent_key', 'check_budget', 'list_services']) await mcp.callTool({ name, arguments: {} })
      await mcp.callTool({ name: 'pay_and_fetch', arguments: { url: `${merchant}/api/report`, purpose: 'Report', maxSats: REPORT_PRICE_SATS } })
      await mcp.close()

      for (const path of ['/admin/agents', '/admin/requests', '/admin/ledger', '/admin/audit?limit=1000', '/admin/audit/verify?full=1', '/admin/vaults', '/admin/audit/head']) {
        await realAdmin(path)
      }
      await realAdmin(`/admin/agents/${created.id}/connect-code`, {})
    } finally {
      globalThis.fetch = realFetch
      for (const s of spies) s.mockRestore()
      stderr.mockRestore()
    }

    const carrying = responses.filter(r => r.text.includes(apiKey))
    expect(carrying.map(r => new URL(r.url).pathname)).toEqual(['/v1/connect'])
    expect(responses.length).toBeGreaterThan(15)
    expect(output.join('\n')).not.toContain(apiKey)
    expect(JSON.stringify(await h.db('audit_log').select())).not.toContain(apiKey)
    expect(JSON.stringify(await h.db('agents').select())).not.toContain(apiKey)
  })
})

/** Admin call through globalThis.fetch (so the leak test sees it); GET without a body, POST with one. */
async function realAdmin (path: string, body?: unknown): Promise<unknown> {
  const res = await globalThis.fetch(`${h.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return await res.json()
}
