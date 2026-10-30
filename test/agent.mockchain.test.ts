/**
 * The agent side, end to end on the mock chain: an MCP server holding the
 * agent's own key pays a BRC-121 merchant through the proxy, from a vault the
 * company funded. The agent checks the merchant's price itself and signs only
 * a payment of exactly that price.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction } from '@bsv/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Wallet } from '@bsv/wallet-toolbox'
import { AGENT_KEY_FILE, loadOrCreateAgentKey, registerAgentKey } from '../src/agent/keys'
import { AgentPayer } from '../src/agent/pay'
import { ProxyClient } from '../src/agent/proxy-client'
import { approveAndFund, fundVault } from '../src/company/vault-client'
import { fingerprint } from '../src/shared/fingerprint'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { createMcpHttpApp } from '../src/mcp/http'
import { createAgentMcpServer } from '../src/mcp/server'
import { ADMIN_TOKEN, createProxyHarness, spendableSats, type ProxyHarness } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string, merchantHost: string
let dataRoot: string
const rules = { get value () { return { allowedHosts: [merchantHost], maxPerPaymentSats: 20_000, dailyBudgetSats: 100_000, approvalThresholdSats: 1_000 } } }

interface McpAgent {
  id: string
  client: ProxyClient
  payer: AgentPayer
  publicKey: string
  /** The agent key's fingerprint, as the MCP agent prints it on start. */
  fingerprint: string
  /** Every proxy path the agent called, in order. */
  calls: string[]
  /** Set to alter the proxy's /v1/pay answers (a malicious or buggy proxy). */
  tamper?: (body: any) => any
  vault: () => Promise<{ status: string, satoshis: number, outpoint: string | null }>
}

/** An agent as the MCP server runs it: own key file, key registered, vault funded by the company. */
async function startAgent (name: string, vaultSats: number): Promise<McpAgent> {
  const created = await h.newAgent(name, rules.value)
  const agent = { id: created.id, calls: [] } as unknown as McpAgent
  const observed: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    agent.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const res = await fetch(input, init)
    if (agent.tamper === undefined || url.pathname !== '/v1/pay') return res
    const body = agent.tamper(await res.json())
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
  }
  agent.client = new ProxyClient({ proxyUrl: h.url, apiKey: created.apiKey, fetch: observed })
  const key = await loadOrCreateAgentKey(join(dataRoot, agent.id))
  await registerAgentKey(agent.client, key.publicKey)
  agent.publicKey = key.publicKey
  agent.fingerprint = fingerprint(key.publicKey)
  if (vaultSats > 0) await fundVault(h.company, h.url, ADMIN_TOKEN, agent.id, vaultSats, agent.fingerprint)
  agent.payer = new AgentPayer({ client: agent.client, key: key.key })
  agent.vault = async () => (await agent.client.budget()).body.vault
  agent.calls.length = 0
  return agent
}

const report = { get url () { return `${merchant}/api/report` } }

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
  merchantHost = new URL(merchant).host
  dataRoot = await mkdtemp(join(tmpdir(), 'agenttresor-mcp-'))
})
afterAll(async () => {
  await h?.close()
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true })
})

describe('agent key', () => {
  it('is created with mode 0600, reused on restart, and its public key registered with the proxy', async () => {
    const created = await h.newAgent('key-bot', rules.value)
    const client = new ProxyClient({ proxyUrl: h.url, apiKey: created.apiKey })
    const dir = join(dataRoot, 'key-bot')

    const first = await loadOrCreateAgentKey(dir)
    expect(first.created).toBe(true)
    expect(first.path).toBe(join(dir, AGENT_KEY_FILE))
    expect((await stat(first.path)).mode & 0o777).toBe(0o600)
    expect(await registerAgentKey(client, first.publicKey)).toBe('registered')

    const restart = await loadOrCreateAgentKey(dir)
    expect(restart.created).toBe(false)
    expect(restart.publicKey).toBe(first.publicKey)
    expect(await registerAgentKey(client, restart.publicKey)).toBe('registered') // same key, still unfunded

    // Once the vault is funded, a restart with the same key is fine…
    await fundVault(h.company, h.url, ADMIN_TOKEN, created.id, 5_000, fingerprint(first.publicKey))
    expect(await registerAgentKey(client, (await loadOrCreateAgentKey(dir)).publicKey)).toBe('already_open')
    expect((await h.admin(`/admin/vaults`)).body.vaults.find((v: any) => v.agentId === created.id).status).toBe('open')
    // …a different key stops the agent with a clear error.
    const other = await loadOrCreateAgentKey(join(dataRoot, 'key-bot-other'))
    await expect(registerAgentKey(client, other.publicKey)).rejects.toThrow(/funded for another key/)
  })

  it('never shows the API key in an error', async () => {
    const apiKey = `agt_${'ab'.repeat(32)}`
    const client = new ProxyClient({ proxyUrl: 'http://127.0.0.1:1', apiKey })
    const err = await client.budget().catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(apiKey)
    expect(() => new ProxyClient({ proxyUrl: h.url, apiKey: 'not-a-key' })).toThrow(/AGENT_API_KEY/)
  })
})

describe('paying', () => {
  it('pays a request under the threshold from the vault; the result has the txid', async () => {
    const agent = await startAgent('pay-bot', 20_000)
    const before = await spendableSats(merchantWallet)
    const r = await agent.payer.payAndFetch({ url: report.url, purpose: 'Market report for the Q4 plan', maxSats: 1_000 })
    expect(r).toMatchObject({ status: 'paid', satoshis: REPORT_PRICE_SATS, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((r as any).response.body.receipt.txid).toBe((r as any).txid)
    expect(await spendableSats(merchantWallet)).toBe(before + REPORT_PRICE_SATS)
    expect(agent.calls).toEqual(['POST /v1/pay', 'POST /v1/requests/' + (r as any).requestId + '/sign'])
  })

  it('refuses to sign when the proxy pays more than the merchant\'s own price; nothing is broadcast', async () => {
    const agent = await startAgent('tamper-bot', 20_000)
    const [vaultBefore, merchantBefore] = [await agent.vault(), await spendableSats(merchantWallet)]
    agent.tamper = body => {
      if (body.status !== 'sign') return body
      const tx = Transaction.fromHex(body.unsignedTx)
      tx.outputs[0].satoshis = tx.outputs[0].satoshis! + 100
      tx.outputs[1].satoshis = tx.outputs[1].satoshis! - 100
      return { ...body, unsignedTx: tx.toHex(), merchantOutput: { ...body.merchantOutput, satoshis: body.merchantOutput.satoshis + 100 } }
    }
    const r = await agent.payer.payAndFetch({ url: report.url, purpose: 'Report', maxSats: 1_000 })
    expect(r).toMatchObject({ status: 'failed', reason: expect.stringMatching(/output 0 pays 600 sats, expected 500/) })
    expect(agent.calls.some(c => c.endsWith('/sign'))).toBe(false) // never signed, never sent
    expect(await agent.vault()).toEqual(vaultBefore)
    expect(await spendableSats(merchantWallet)).toBe(merchantBefore)
  })

  it('refuses a price above maxSats before calling the proxy', async () => {
    const agent = await startAgent('max-bot', 20_000)
    const r = await agent.payer.payAndFetch({ url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 2 }, purpose: 'Hotel', maxSats: 5_000 })
    expect(r).toMatchObject({ status: 'denied', deniedBy: 'agent', reason: expect.stringMatching(/10000 sats, above your maxSats of 5000/) })
    expect(agent.calls).toEqual([])
  })

  it('above the threshold: pending; once the company funds it, check_request pays it from the request vault', async () => {
    const agent = await startAgent('approval-bot', 20_000)
    const body = { roomType: 'standard', nights: 1 }
    const r = await agent.payer.payAndFetch({ url: `${merchant}/api/hotel/book`, method: 'POST', body, purpose: 'Hotel for the Munich trip', maxSats: 5_000 })
    expect(r).toMatchObject({ status: 'pending', satoshis: ROOM_RATES_SATS.standard, requestId: expect.stringMatching(/^R-/) })
    const id = (r as any).requestId

    expect(await agent.payer.checkRequest(id)).toMatchObject({ status: 'pending', requestId: id })
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, agent.fingerprint)

    const [before, vaultBefore] = [await spendableSats(merchantWallet), await agent.vault()]
    agent.calls.length = 0
    const done = await agent.payer.checkRequest(id)
    expect(done).toMatchObject({ status: 'paid', requestId: id, satoshis: ROOM_RATES_SATS.standard })
    expect((done as any).response.body.order).toMatchObject(body)
    expect(agent.calls).toEqual([`GET /v1/requests/${id}`, `POST /v1/requests/${id}/execute`, `POST /v1/requests/${id}/sign`])
    expect(await spendableSats(merchantWallet)).toBe(before + ROOM_RATES_SATS.standard)
    expect(await agent.vault()).toEqual(vaultBefore) // paid from the request vault, not the agent's
    expect(await agent.payer.checkRequest(id)).toMatchObject({ status: 'paid', txid: (done as any).txid }) // idempotent
  })

  it('a denial is returned as a structured result and never retried', async () => {
    const agent = await startAgent('denied-bot', 20_000)
    const r = await agent.payer.payAndFetch({ url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 5 }, purpose: 'Long stay', maxSats: 50_000 })
    expect(r).toMatchObject({ status: 'denied', deniedBy: 'company', requestId: expect.stringMatching(/^R-/), reason: expect.stringMatching(/maximum per payment/) })
    expect(agent.calls).toEqual(['POST /v1/pay'])
  })

  it('retries once when the signature arrives after the 20 s window', async () => {
    const agent = await startAgent('late-bot', 20_000)
    // The first /sign arrives "late" (proxy clock shifted); the retry uses the normal clock.
    let firstSign = true
    const realSign = agent.client.sign.bind(agent.client)
    agent.client.sign = async (id, sig) => {
      if (!firstSign) return await realSign(id, sig)
      firstSign = false
      h.clock.offset = 21_000
      try { return await realSign(id, sig) } finally { h.clock.offset = 0 }
    }
    const r = await agent.payer.payAndFetch({ url: report.url, purpose: 'Report, slow signer', maxSats: 1_000 })
    expect(r).toMatchObject({ status: 'paid', satoshis: REPORT_PRICE_SATS })
    expect(agent.calls.filter(c => c.endsWith('/execute'))).toHaveLength(1)
  })
})

describe('MCP server', () => {
  const textOf = (res: any): string => res.content.map((c: any) => c.text).join('\n')

  it('lists the tools over an in-memory transport and pays end to end with pay_and_fetch', async () => {
    const agent = await startAgent('mcp-bot', 20_000)
    const server = createAgentMcpServer({ payer: agent.payer, client: agent.client, merchantUrls: [merchant], agentPublicKey: agent.publicKey })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const mcp = new Client({ name: 'test-model', version: '1.0.0' })
    await mcp.connect(clientSide)

    const { tools } = await mcp.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['check_budget', 'check_request', 'get_price', 'list_services', 'pay_and_fetch', 'show_agent_key'])
    expect(textOf(await mcp.callTool({ name: 'show_agent_key', arguments: {} }))).toMatch(new RegExp(`^Agent key fingerprint: ${agent.fingerprint}\\.`))
    expect(tools.find(t => t.name === 'pay_and_fetch')!.inputSchema.required).toEqual(expect.arrayContaining(['url', 'purpose', 'maxSats']))
    expect(mcp.getInstructions()).toMatch(/check_budget and get_price/)

    expect(textOf(await mcp.callTool({ name: 'list_services', arguments: {} }))).toContain(`${merchant}/api/report`)
    expect(textOf(await mcp.callTool({ name: 'check_budget', arguments: {} }))).toMatch(/vault: 20000 sats \(open\)/)
    expect(textOf(await mcp.callTool({ name: 'get_price', arguments: { url: report.url } }))).toMatch(/asks 500 sats/)

    const paid = await mcp.callTool({ name: 'pay_and_fetch', arguments: { url: report.url, purpose: 'Market report for the user', maxSats: 600 } })
    expect(paid.isError).toBe(false)
    expect(textOf(paid)).toMatch(/^Paid 500 sats from the company vault \(txid [0-9a-f]{64}\)/)
    expect(textOf(paid)).toContain('"reportId"')

    // Above the threshold through the tools: pending, the company funds it, check_request pays it.
    const hotel = { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 } }
    const pending = await mcp.callTool({ name: 'pay_and_fetch', arguments: { ...hotel, purpose: 'Hotel for the user\'s trip', maxSats: 5_000 } })
    expect(textOf(pending)).toMatch(/^Waiting for approval: request R-[0-9A-F]{10} \(2000 sats\).*funding it from its wallet/)
    const requestId = /request (R-[0-9A-F]{10})/.exec(textOf(pending))![1]
    expect(textOf(await mcp.callTool({ name: 'check_request', arguments: { requestId } }))).toMatch(/^Waiting for approval/)
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, requestId, agent.fingerprint)
    const vaultBefore = await agent.vault()
    const approvedPaid = await mcp.callTool({ name: 'check_request', arguments: { requestId } })
    expect(approvedPaid.isError).toBe(false)
    expect(textOf(approvedPaid)).toMatch(/^Paid 2000 sats from the company vault \(txid [0-9a-f]{64}\)/)
    expect(textOf(approvedPaid)).toContain('"bookingId"')
    expect(await agent.vault()).toEqual(vaultBefore)

    const refused = await mcp.callTool({ name: 'pay_and_fetch', arguments: { url: report.url, purpose: 'Too cheap a limit', maxSats: 100 } })
    expect(textOf(refused)).toMatch(/Refused by your own maxSats limit/)
    const invalid = await mcp.callTool({ name: 'pay_and_fetch', arguments: { url: report.url, maxSats: 600 } })
    expect(invalid.isError).toBe(true) // purpose is required
    await mcp.close()
  })

  describe('over Streamable HTTP', () => {
    const TOKEN = 'test-mcp-token-0123456789'
    let server: Server
    let url: string

    beforeAll(async () => {
      const agent = await startAgent('http-bot', 5_000)
      const app = createMcpHttpApp({ createServer: () => createAgentMcpServer({ payer: agent.payer, client: agent.client, merchantUrls: [merchant], agentPublicKey: agent.publicKey }), token: TOKEN })
      await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { resolve() }) })
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    })
    afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

    it('refuses a request without MCP_TOKEN (401)', async () => {
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(init) })).status).toBe(401)
      expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong-token' }, body: JSON.stringify(init) })).status).toBe(401)
    })

    it('serves the tools with the token', async () => {
      const mcp = new Client({ name: 'test-model', version: '1.0.0' })
      await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
      expect((await mcp.listTools()).tools).toHaveLength(6)
      await mcp.close()
    })

    it('needs a real token to start', () => {
      expect(() => createMcpHttpApp({ createServer: () => { throw new Error('unused') }, token: 'short' })).toThrow(/at least 16/)
    })
  })
})
