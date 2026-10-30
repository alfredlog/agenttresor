/**
 * Spend-control proxy, end to end on the mock chain: agents ask the proxy to
 * pay real BRC-121 merchants; the proxy prices each request, applies the
 * company's rules, builds the vault payment the agent signs, and keeps the ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import express, { type Express } from 'express'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createPaymentMiddleware } from '../src/shared/brc121'
import { approveAndFund, reclaimRequestVault } from '../src/company/vault-client'
import { createMerchantApp, ROOM_RATES_SATS } from '../src/merchant/app'
import type { Notifier } from '../src/proxy/notifier'
import type { PaymentRequestRecord } from '../src/proxy/store'
import { ADMIN_TOKEN, createProxyHarness, fp, spendableSats, type ProxyHarness, type TestAgent } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet, flakyWallet: Wallet
let merchant: string, merchantHost: string, flaky: string, flakyHost: string

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

beforeAll(async () => {
  h = await createProxyHarness({ notifier })
  ;[merchantWallet, flakyWallet] = await Promise.all([h.chain.makeWallet(), h.chain.makeWallet()])
  merchant = await h.listen(createMerchantApp(merchantWallet))
  flaky = await h.listen(createFlakyMerchant(flakyWallet))
  merchantHost = new URL(merchant).host
  flakyHost = new URL(flaky).host
})
afterAll(async () => { await h?.close() })

describe('spend-control proxy', () => {
  let agent: TestAgent
  const rules = () => ({ allowedHosts: [merchantHost, flakyHost], maxPerPaymentSats: 20_000, dailyBudgetSats: 30_000, approvalThresholdSats: 1_000 })

  beforeAll(async () => { agent = await h.createAgent('research-bot', rules(), 100_000) })

  it('pays an allowed request under the threshold; the merchant is credited and the ledger has the txid', async () => {
    const before = await spendableSats(merchantWallet)
    const res = await h.payAndSign(agent, { url: `${merchant}/api/report`, purpose: 'Market research for Q4 plan' }, 500)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'paid', satoshis: 500, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(res.body.response.body.receipt).toEqual({ txid: res.body.txid, satoshisPaid: 500 })
    expect(await spendableSats(merchantWallet)).toBe(before + 500)

    const ledger = await h.admin('/admin/ledger')
    const entry = ledger.body.entries.find((e: any) => e.requestId === res.body.requestId)
    expect(entry).toMatchObject({ status: 'paid', txid: res.body.txid, satoshis: 500, agentName: 'research-bot', purpose: 'Market research for Q4 plan' })
    expect(entry.explorerUrl).toBe(`https://test.whatsonchain.com/tx/${res.body.txid}`)

    const own = await h.call(`/v1/requests/${res.body.requestId}`, agent.key)
    expect(own.body).toMatchObject({ status: 'paid', txid: res.body.txid, response: { status: 200 } })
  })

  it('refuses a host that is not allowed (403) and pays nothing', async () => {
    const [vaultBefore, merchantBefore] = [(await h.call('/v1/budget', agent.key)).body.vault, await spendableSats(merchantWallet)]
    const other = merchant.replace('localhost', '127.0.0.1') // same server, host not on the list
    const res = await h.pay(agent, { url: `${other}/api/report`, purpose: 'Try another host' })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/not allowed/), requestId: expect.stringMatching(/^R-/) })
    expect((await h.call('/v1/budget', agent.key)).body.vault).toEqual(vaultBefore)
    expect(await spendableSats(merchantWallet)).toBe(merchantBefore)
  })

  it('refuses a payment over the maximum per payment (403)', async () => {
    const res = await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 5 }, purpose: 'Long stay' })
    expect(res.status).toBe(403)
    expect(res.body.reason).toMatch(/maximum per payment/)
  })

  it('holds a payment above the threshold; the company funds it, then execute and sign pay it', async () => {
    const res = await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel for the Munich trip' })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ status: 'pending', requestId: expect.stringMatching(/^R-/) })
    const id = res.body.requestId
    expect(notifier.approvals.map(r => r.id)).toContain(id)

    expect((await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })).status).toBe(409) // not approved yet
    const pending = await h.admin('/admin/requests?status=pending')
    expect(pending.body.requests.map((r: any) => r.requestId)).toContain(id)

    // A plain approval is refused: approving means funding.
    expect((await h.admin(`/admin/requests/${id}/approve`, { method: 'POST' })).status).toBe(400)
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    expect((await h.call(`/v1/requests/${id}`, agent.key)).body).toMatchObject({ status: 'approved', decidedBy: 'company' })
    expect(notifier.decisions.map(r => r.id)).toContain(id)

    const before = await spendableSats(merchantWallet)
    const exec = await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })
    expect(exec.body.status).toBe('sign')
    const done = await h.sign(agent, exec.body, ROOM_RATES_SATS.standard)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ status: 'paid', satoshis: ROOM_RATES_SATS.standard })
    expect(done.body.response.body.order).toMatchObject({ roomType: 'standard', nights: 1 })
    expect(await spendableSats(merchantWallet)).toBe(before + ROOM_RATES_SATS.standard)
  })

  it('a denied request cannot be executed', async () => {
    const res = await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 1 }, purpose: 'Suite upgrade' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    const denied = await h.admin(`/admin/requests/${id}/deny`, { method: 'POST', body: { reason: 'standard room is enough' } })
    expect(denied.body).toMatchObject({ status: 'denied', reason: 'standard room is enough' })
    const exec = await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })
    expect(exec.status).toBe(409)
    expect(exec.body.error).toMatch(/denied/)
    expect((await h.admin(`/admin/requests/${id}/approve`, { method: 'POST' })).status).toBe(409)
  })

  it('refuses to execute when the price changed after approval, builds nothing, and the company reclaims', async () => {
    flakyState.price = 1_500
    const res = await h.pay(agent, { url: `${flaky}/item`, purpose: 'Widget' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    const funded = await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    flakyState.price = 1_800
    const [vaultBefore, flakyBefore] = [(await h.call('/v1/budget', agent.key)).body.vault, await spendableSats(flakyWallet)]
    const exec = await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })
    flakyState.price = 800
    expect(exec.status).toBe(409)
    expect(exec.body).toMatchObject({ status: 'failed', reason: expect.stringMatching(/price changed from 1500 to 1800/) })
    expect((await h.call('/v1/budget', agent.key)).body.vault).toEqual(vaultBefore)
    expect(await spendableSats(flakyWallet)).toBe(flakyBefore)

    const companyBefore = await spendableSats(h.company)
    const reclaimed = await reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, id)
    expect(reclaimed.satoshis).toBe(funded.satoshis)
    expect(await spendableSats(h.company)).toBeGreaterThan(companyBefore + funded.satoshis - 100)
  })

  it('records paid_not_delivered when the merchant fails after payment, and counts it in the budget', async () => {
    flakyState.price = 800
    flakyState.fail = true
    const budgetBefore = (await h.call('/v1/budget', agent.key)).body
    const flakyBefore = await spendableSats(flakyWallet)
    const res = await h.payAndSign(agent, { url: `${flaky}/item`, purpose: 'Widget, second try' }, 800)
    flakyState.fail = false
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ status: 'paid_not_delivered', satoshis: 800, txid: expect.stringMatching(/^[0-9a-f]{64}$/), reason: expect.stringMatching(/500/) })
    expect(await spendableSats(flakyWallet)).toBe(flakyBefore + 800)
    const budgetAfter = (await h.call('/v1/budget', agent.key)).body
    expect(budgetAfter.spentTodaySats).toBe(budgetBefore.spentTodaySats + 800)
    expect(budgetAfter.remainingTodaySats).toBe(30_000 - budgetAfter.spentTodaySats)
    expect(budgetAfter.vault.satoshis).toBeLessThan(budgetBefore.vault.satoshis - 800) // price + fee left the vault
    const ledger = await h.admin('/admin/ledger')
    expect(ledger.body.entries.find((e: any) => e.requestId === res.body.requestId)).toMatchObject({ status: 'paid_not_delivered', txid: res.body.txid })
  })

  it('refuses a payment over the daily budget (403)', async () => {
    const small = await h.createAgent('small-budget-bot', { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 1_200, approvalThresholdSats: 1_000 }, 10_000)
    expect((await h.payAndSign(small, { url: `${merchant}/api/report`, purpose: 'Report 1' }, 500)).status).toBe(200)
    expect((await h.payAndSign(small, { url: `${merchant}/api/report`, purpose: 'Report 2' }, 500)).status).toBe(200)
    const third = await h.pay(small, { url: `${merchant}/api/report`, purpose: 'Report 3' })
    expect(third.status).toBe(403)
    expect(third.body.reason).toMatch(/daily budget/)
    expect((await h.call('/v1/budget', small.key)).body).toMatchObject({ spentTodaySats: 1_000, remainingTodaySats: 200 })

    // The admin raises the budget; the same request now goes through.
    const put = await h.admin(`/admin/agents/${small.id}/rules`, { method: 'PUT', body: { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 2_000, approvalThresholdSats: 1_000 } })
    expect(put.status).toBe(200)
    expect((await h.admin(`/admin/agents/${small.id}/rules`, { method: 'PUT', body: { allowedHosts: [merchantHost] } })).status).toBe(400)
    expect((await h.payAndSign(small, { url: `${merchant}/api/report`, purpose: 'Report 3, retry' }, 500)).status).toBe(200)
  })

  it('returns a free route without paying or recording', async () => {
    const res = await h.pay(agent, { url: `${merchant}/api/catalog`, purpose: 'Read the catalog' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'free', satoshis: 0, response: { status: 200 } })
  })

  it('requires a purpose', async () => {
    const res = await h.pay(agent, { url: `${merchant}/api/report`, purpose: '  ' })
    expect(res.status).toBe(400)
  })
})

describe('authentication', () => {
  it('refuses a missing or wrong agent key (401)', async () => {
    expect((await h.call('/v1/pay', undefined, { method: 'POST', body: { url: `${merchant}/api/report`, purpose: 'x' } })).status).toBe(401)
    expect((await h.call('/v1/budget', `agt_${'0'.repeat(64)}`)).status).toBe(401)
    expect((await h.call('/v1/budget', 'not-a-key')).status).toBe(401)
    expect((await h.call('/v1/vault/agent-key', undefined, { method: 'POST', body: {} })).status).toBe(401)
  })

  it('agent A cannot read, execute or sign agent B\'s request', async () => {
    const r = { allowedHosts: [merchantHost], maxPerPaymentSats: 5_000, dailyBudgetSats: 5_000, approvalThresholdSats: 100 }
    const a = await h.createAgent('agent-a', r, 5_000)
    const b = await h.createAgent('agent-b', r, 5_000)
    const res = await h.pay(b, { url: `${merchant}/api/report`, purpose: 'B wants a report' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    expect((await h.call(`/v1/requests/${id}`, b.key)).status).toBe(200)
    expect((await h.call(`/v1/requests/${id}`, a.key)).status).toBe(404)
    expect((await h.call(`/v1/requests/${id}/execute`, a.key, { method: 'POST' })).status).toBe(404)
    expect((await h.call(`/v1/requests/${id}/sign`, a.key, { method: 'POST', body: { signature: '00' } })).status).toBe(404)
  })

  it('creation returns a code, not a key; the agents list never contains a key or its hash', async () => {
    const r = { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 2_000, approvalThresholdSats: 500 }
    const created = await h.admin('/admin/agents', { method: 'POST', body: { name: 'masked-bot', rules: r } })
    expect(created.status).toBe(201)
    expect(Object.keys(created.body).sort()).toEqual(['connectCode', 'connectUrl', 'expiresAt', 'id', 'name', 'rules'])
    expect(JSON.stringify(created.body)).not.toMatch(/agt_/)
    expect((await h.admin('/admin/agents')).body.agents.find((x: any) => x.id === created.body.id)).toMatchObject({ key: null, connected: false })

    const apiKey: string = (await h.call('/v1/connect', undefined, { method: 'POST', body: { code: created.body.connectCode } })).body.apiKey
    expect(apiKey).toMatch(/^agt_[0-9a-f]{64}$/)
    const hash = createHash('sha256').update(apiKey).digest('hex')

    const list = await h.admin('/admin/agents')
    const text = JSON.stringify(list.body)
    expect(text).not.toContain(apiKey)
    expect(text).not.toContain(apiKey.slice(4)) // not even without its prefix
    expect(text).not.toContain(hash)
    expect(text).not.toMatch(/apiKey|key_hash|keyHash/)
    const listed = list.body.agents.find((x: any) => x.id === created.body.id)
    expect(listed).toEqual({
      id: created.body.id,
      name: 'masked-bot',
      status: 'active',
      key: `${apiKey.slice(0, 8)}…`,
      connected: true,
      createdAt: expect.any(String),
      rules: { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 2_000, approvalThresholdSats: 500 },
      vault: { status: 'no_key', satoshis: 0, agentPub: null }
    })
    // An agent with a funded vault shows its status, balance and public signing key.
    const funded = await h.createAgent('listed-bot', { allowedHosts: [merchantHost], maxPerPaymentSats: 1_000, dailyBudgetSats: 2_000, approvalThresholdSats: 500 }, 3_000)
    const listedFunded = (await h.admin('/admin/agents')).body.agents.find((x: any) => x.id === funded.id)
    expect(listedFunded.vault).toEqual({ status: 'open', satoshis: 3_000, agentPub: funded.signer.toPublicKey().toString() })
  })

  it('refuses admin routes without the admin token (401)', async () => {
    const routes: Array<[string, string]> = [
      ['POST', '/admin/agents'], ['GET', '/admin/agents'], ['PUT', '/admin/agents/A-1/rules'], ['GET', '/admin/requests'],
      ['POST', '/admin/requests/R-1/approve'], ['POST', '/admin/requests/R-1/deny'], ['GET', '/admin/ledger'],
      ['GET', '/admin/vaults'], ['GET', '/admin/vaults/A-1/params'], ['POST', '/admin/vaults/A-1/funded'],
      ['GET', '/admin/vaults/A-1/utxo'], ['POST', '/admin/vaults/A-1/reclaimed']
    ]
    for (const [method, path] of routes) {
      expect((await h.call(path, undefined, { method, body: method === 'GET' ? undefined : {} })).status).toBe(401)
      expect((await h.call(path, 'wrong-token', { method, body: method === 'GET' ? undefined : {} })).status).toBe(401)
    }
  })
})
