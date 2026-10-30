/**
 * Spend-control proxy, end to end on the mock chain: agents ask the proxy to
 * pay real BRC-121 merchants; the proxy prices each request, applies the
 * company's rules, pays from its wallet and keeps the ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { type Express } from 'express'
import type { Knex } from 'knex'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createPaymentMiddleware } from '../src/shared/brc121'
import { createMerchantApp, ROOM_RATES_SATS } from '../src/merchant/app'
import { createProxyApp } from '../src/proxy/app'
import type { Notifier } from '../src/proxy/notifier'
import { WalletPayer } from '../src/proxy/payer'
import { openProxyDb, type PaymentRequestRecord } from '../src/proxy/store'
import { createMockChain, type MockChain } from './helpers/mockchain'

const ADMIN_TOKEN = 'test-admin-token-0123456789'

let chain: MockChain
let db: Knex
let merchantWallet: Wallet, flakyWallet: Wallet, proxyWallet: Wallet
const servers: Server[] = []
let merchant: string, merchantHost: string, flaky: string, flakyHost: string, proxy: string

/** A merchant whose price and delivery the test controls. */
const flakyState = { price: 800, fail: false }
function createFlakyMerchant (wallet: Wallet): Express {
  const app = express()
  app.get('/item', createPaymentMiddleware({ wallet, calculatePrice: () => flakyState.price }), (req, res) => {
    if (flakyState.fail) { res.status(500).json({ error: 'out of stock' }); return }
    res.json({ item: 'widget', receipt: (req as any).payment })
  })
  return app
}

class SpyNotifier implements Notifier {
  approvals: PaymentRequestRecord[] = []
  decisions: PaymentRequestRecord[] = []
  async approvalNeeded (req: PaymentRequestRecord): Promise<void> { this.approvals.push(req) }
  async decided (req: PaymentRequestRecord): Promise<void> { this.decisions.push(req) }
}
const notifier = new SpyNotifier()

const listen = async (app: Express): Promise<string> => await new Promise(resolve => {
  const s = app.listen(0, () => resolve(`http://localhost:${(s.address() as AddressInfo).port}`))
  servers.push(s)
})
const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

async function call (path: string, token: string | undefined, init: { method?: string, body?: unknown } = {}): Promise<{ status: number, body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${proxy}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const admin = async (path: string, init: { method?: string, body?: unknown } = {}): Promise<{ status: number, body: any }> => await call(path, ADMIN_TOKEN, init)
const pay = async (key: string, body: unknown): Promise<{ status: number, body: any }> => await call('/v1/pay', key, { method: 'POST', body })

async function createAgent (name: string, rules: object): Promise<string> {
  const res = await admin('/admin/agents', { method: 'POST', body: { name, rules } })
  expect(res.status).toBe(201)
  return res.body.apiKey
}

beforeAll(async () => {
  chain = await createMockChain()
  ;[merchantWallet, flakyWallet, proxyWallet] = await Promise.all([chain.makeWallet(), chain.makeWallet(), chain.makeWallet()])
  await chain.fund(proxyWallet)
  merchant = await listen(createMerchantApp(merchantWallet))
  flaky = await listen(createFlakyMerchant(flakyWallet))
  merchantHost = new URL(merchant).host
  flakyHost = new URL(flaky).host
  db = await openProxyDb(':memory:')
  proxy = await listen(createProxyApp({ db, payer: new WalletPayer(proxyWallet), notifier, adminToken: ADMIN_TOKEN, network: 'test' }))
})
afterAll(async () => {
  for (const s of servers) await new Promise(resolve => s.close(resolve))
  await db?.destroy()
  await chain?.close()
})

describe('spend-control proxy', () => {
  let key: string
  const rules = () => ({ allowedHosts: [merchantHost, flakyHost], maxPerPaymentSats: 20_000, dailyBudgetSats: 30_000, approvalThresholdSats: 1_000 })

  beforeAll(async () => { key = await createAgent('research-bot', rules()) })

  it('pays an allowed request under the threshold; the merchant is credited and the ledger has the txid', async () => {
    const before = await spendableSats(merchantWallet)
    const res = await pay(key, { url: `${merchant}/api/report`, purpose: 'Market research for Q4 plan' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'paid', satoshis: 500, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(res.body.response.body.receipt).toEqual({ txid: res.body.txid, satoshisPaid: 500 })
    expect(await spendableSats(merchantWallet)).toBe(before + 500)

    const ledger = await admin('/admin/ledger')
    const entry = ledger.body.entries.find((e: any) => e.requestId === res.body.requestId)
    expect(entry).toMatchObject({ status: 'paid', txid: res.body.txid, satoshis: 500, agentName: 'research-bot', purpose: 'Market research for Q4 plan' })
    expect(entry.explorerUrl).toBe(`https://test.whatsonchain.com/tx/${res.body.txid}`)

    const own = await call(`/v1/requests/${res.body.requestId}`, key)
    expect(own.body).toMatchObject({ status: 'paid', txid: res.body.txid, response: { status: 200 } })
  })

  it('refuses a host that is not allowed (403) and pays nothing', async () => {
    const [proxyBefore, merchantBefore] = [await spendableSats(proxyWallet), await spendableSats(merchantWallet)]
    const other = merchant.replace('localhost', '127.0.0.1') // same server, host not on the list
    const res = await pay(key, { url: `${other}/api/report`, purpose: 'Try another host' })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/not allowed/), requestId: expect.stringMatching(/^R-/) })
    expect(await spendableSats(proxyWallet)).toBe(proxyBefore)
    expect(await spendableSats(merchantWallet)).toBe(merchantBefore)
  })

  it('refuses a payment over the maximum per payment (403)', async () => {
    const res = await pay(key, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 5 }, purpose: 'Long stay' })
    expect(res.status).toBe(403)
    expect(res.body.reason).toMatch(/maximum per payment/)
  })

  it('holds a payment above the threshold; approve, then execute pays it', async () => {
    const res = await pay(key, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel for the Munich trip' })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ status: 'pending', requestId: expect.stringMatching(/^R-/) })
    const id = res.body.requestId
    expect(notifier.approvals.map(r => r.id)).toContain(id)

    expect((await call(`/v1/requests/${id}/execute`, key, { method: 'POST' })).status).toBe(409) // not approved yet
    const pending = await admin('/admin/requests?status=pending')
    expect(pending.body.requests.map((r: any) => r.requestId)).toContain(id)

    const approved = await admin(`/admin/requests/${id}/approve`, { method: 'POST' })
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: 'admin' })
    expect(notifier.decisions.map(r => r.id)).toContain(id)

    const before = await spendableSats(merchantWallet)
    const done = await call(`/v1/requests/${id}/execute`, key, { method: 'POST' })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ status: 'paid', satoshis: ROOM_RATES_SATS.standard })
    expect(done.body.response.body.order).toMatchObject({ roomType: 'standard', nights: 1 })
    expect(await spendableSats(merchantWallet)).toBe(before + ROOM_RATES_SATS.standard)
  })

  it('a denied request cannot be executed', async () => {
    const res = await pay(key, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 1 }, purpose: 'Suite upgrade' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    const denied = await admin(`/admin/requests/${id}/deny`, { method: 'POST', body: { reason: 'standard room is enough' } })
    expect(denied.body).toMatchObject({ status: 'denied', reason: 'standard room is enough' })
    const exec = await call(`/v1/requests/${id}/execute`, key, { method: 'POST' })
    expect(exec.status).toBe(409)
    expect(exec.body.error).toMatch(/denied/)
    expect((await admin(`/admin/requests/${id}/approve`, { method: 'POST' })).status).toBe(409)
  })

  it('refuses to execute when the price rose after approval, and pays nothing', async () => {
    flakyState.price = 1_500
    const res = await pay(key, { url: `${flaky}/item`, purpose: 'Widget' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    await admin(`/admin/requests/${id}/approve`, { method: 'POST' })
    flakyState.price = 1_800
    const [proxyBefore, flakyBefore] = [await spendableSats(proxyWallet), await spendableSats(flakyWallet)]
    const exec = await call(`/v1/requests/${id}/execute`, key, { method: 'POST' })
    expect(exec.status).toBe(409)
    expect(exec.body).toMatchObject({ status: 'failed', reason: expect.stringMatching(/price rose from 1500 to 1800/) })
    expect(await spendableSats(proxyWallet)).toBe(proxyBefore)
    expect(await spendableSats(flakyWallet)).toBe(flakyBefore)
  })

  it('records paid_not_delivered when the merchant fails after payment, and counts it in the budget', async () => {
    flakyState.price = 800
    flakyState.fail = true
    const budgetBefore = (await call('/v1/budget', key)).body
    const flakyBefore = await spendableSats(flakyWallet)
    const res = await pay(key, { url: `${flaky}/item`, purpose: 'Widget, second try' })
    flakyState.fail = false
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ status: 'paid_not_delivered', satoshis: 800, txid: expect.stringMatching(/^[0-9a-f]{64}$/), reason: expect.stringMatching(/500/) })
    expect(await spendableSats(flakyWallet)).toBe(flakyBefore + 800)
    const budgetAfter = (await call('/v1/budget', key)).body
    expect(budgetAfter.spentTodaySats).toBe(budgetBefore.spentTodaySats + 800)
    expect(budgetAfter.remainingTodaySats).toBe(30_000 - budgetAfter.spentTodaySats)
    const ledger = await admin('/admin/ledger')
    expect(ledger.body.entries.find((e: any) => e.requestId === res.body.requestId)).toMatchObject({ status: 'paid_not_delivered', txid: res.body.txid })
  })

  it('refuses a payment over the daily budget (403)', async () => {
    const small = await createAgent('small-budget-bot', { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 1_200, approvalThresholdSats: 1_000 })
    expect((await pay(small, { url: `${merchant}/api/report`, purpose: 'Report 1' })).status).toBe(200)
    expect((await pay(small, { url: `${merchant}/api/report`, purpose: 'Report 2' })).status).toBe(200)
    const third = await pay(small, { url: `${merchant}/api/report`, purpose: 'Report 3' })
    expect(third.status).toBe(403)
    expect(third.body.reason).toMatch(/daily budget/)
    expect((await call('/v1/budget', small)).body).toMatchObject({ spentTodaySats: 1_000, remainingTodaySats: 200 })

    // The admin raises the budget; the same request now goes through.
    const agentId = (await admin('/admin/agents')).body.agents.find((a: any) => a.name === 'small-budget-bot').id
    const put = await admin(`/admin/agents/${agentId}/rules`, { method: 'PUT', body: { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 2_000, approvalThresholdSats: 1_000 } })
    expect(put.status).toBe(200)
    expect((await admin(`/admin/agents/${agentId}/rules`, { method: 'PUT', body: { allowedHosts: [merchantHost] } })).status).toBe(400)
    expect((await pay(small, { url: `${merchant}/api/report`, purpose: 'Report 3, retry' })).status).toBe(200)
  })

  it('returns a free route without paying or recording', async () => {
    const res = await pay(key, { url: `${merchant}/api/catalog`, purpose: 'Read the catalog' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'free', satoshis: 0, response: { status: 200 } })
  })

  it('requires a purpose', async () => {
    const res = await pay(key, { url: `${merchant}/api/report`, purpose: '  ' })
    expect(res.status).toBe(400)
  })
})

describe('authentication', () => {
  it('refuses a missing or wrong agent key (401)', async () => {
    expect((await pay(undefined as unknown as string, { url: `${merchant}/api/report`, purpose: 'x' })).status).toBe(401)
    expect((await call('/v1/budget', `agt_${'0'.repeat(64)}`)).status).toBe(401)
    expect((await call('/v1/budget', 'not-a-key')).status).toBe(401)
  })

  it('agent A cannot read or execute agent B\'s request', async () => {
    const a = await createAgent('agent-a', { allowedHosts: [merchantHost], maxPerPaymentSats: 5_000, dailyBudgetSats: 5_000, approvalThresholdSats: 100 })
    const b = await createAgent('agent-b', { allowedHosts: [merchantHost], maxPerPaymentSats: 5_000, dailyBudgetSats: 5_000, approvalThresholdSats: 100 })
    const res = await pay(b, { url: `${merchant}/api/report`, purpose: 'B wants a report' })
    expect(res.status).toBe(202)
    expect((await call(`/v1/requests/${res.body.requestId}`, b)).status).toBe(200)
    expect((await call(`/v1/requests/${res.body.requestId}`, a)).status).toBe(404)
    expect((await call(`/v1/requests/${res.body.requestId}/execute`, a, { method: 'POST' })).status).toBe(404)
  })

  it('returns the key once and masks it afterwards', async () => {
    const created = await admin('/admin/agents', { method: 'POST', body: { name: 'masked-bot' } })
    expect(created.body.apiKey).toMatch(/^agt_[0-9a-f]{64}$/)
    const listed = (await admin('/admin/agents')).body.agents.find((x: any) => x.id === created.body.id)
    expect(listed.key).toBe(`${created.body.apiKey.slice(0, 8)}…`)
    expect(JSON.stringify((await admin('/admin/agents')).body)).not.toContain(created.body.apiKey)
  })

  it('refuses admin routes without the admin token (401)', async () => {
    const routes: Array<[string, string]> = [
      ['POST', '/admin/agents'], ['GET', '/admin/agents'], ['PUT', '/admin/agents/A-1/rules'], ['GET', '/admin/requests'],
      ['POST', '/admin/requests/R-1/approve'], ['POST', '/admin/requests/R-1/deny'], ['GET', '/admin/ledger']
    ]
    for (const [method, path] of routes) {
      expect((await call(path, undefined, { method, body: method === 'GET' ? undefined : {} })).status).toBe(401)
      expect((await call(path, 'wrong-token', { method, body: method === 'GET' ? undefined : {} })).status).toBe(401)
    }
  })
})
