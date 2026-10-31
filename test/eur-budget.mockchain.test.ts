/**
 * Budgets in euros end to end on the mock chain, with a fake BSV/EUR rate the
 * test sets: EUR limits at the boundary, the rate recorded with every request,
 * a missing or stale rate denied, the daily EUR budget counting the cents
 * stored at payment time, re-evaluation at execute time, SAT agents unchanged,
 * the v2 on-chain ceiling, the admin API round trip and the agent tools.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Wallet } from '@bsv/wallet-toolbox'
import { ProxyClient } from '../src/agent/proxy-client'
import { createAgentTools } from '../src/agent/tools'
import { approveAndFund, fundVault, getVaultParams } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { MAX_RATE_AGE_MS, type RateProvider, type RateQuote } from '../src/shared/rate'
import { formToRules, rulesToForm } from '../src/shared/rules-form'
import { ADMIN_TOKEN, createProxyHarness, fp, type ProxyHarness, type TestAgent } from './helpers/proxy'

/** The rate the proxy sees; the test sets it. */
const fake: { quote?: RateQuote } = {}
const rates: RateProvider = { current: async () => fake.quote }
/** 1 BSV = `rate` €, updated `ageMs` ago. */
const setRate = (rate: number | undefined, ageMs = 0): void => {
  fake.quote = rate === undefined ? undefined : { rate, at: Date.now() - ageMs, source: 'test' }
}

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string, merchantHost: string

const eurRules = (extra: object = {}): object => ({
  allowedHosts: [merchantHost], currency: 'EUR', maxPerPaymentCents: 5, dailyBudgetCents: 12, approvalThresholdCents: 5, ...extra
})
const report = (): object => ({ url: `${merchant}/api/report`, purpose: 'Market report' })
const hotel = (): object => ({ url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel, 1 night' })
const requestOf = async (a: TestAgent, id: string): Promise<any> => (await h.call(`/v1/requests/${id}`, a.key)).body
const row = async (id: string): Promise<any> => await h.db('requests').where({ id }).first()

beforeAll(async () => {
  h = await createProxyHarness({ app: { rates } })
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
  merchantHost = new URL(merchant).host
})
afterAll(async () => { await h?.close() })

describe('payments under EUR rules', () => {
  it('the maximum per payment holds at the boundary, rounding up', async () => {
    const agent = await h.createAgent('eur-boundary', eurRules(), 20_000)
    // 1 BSV = 10 000 €: the 500-sat report is exactly 5 cents, the maximum.
    setRate(10_000)
    const paid = await h.payAndSign(agent, report(), REPORT_PRICE_SATS)
    expect(paid.body).toMatchObject({ status: 'paid', satoshis: REPORT_PRICE_SATS })
    expect(await row(paid.body.requestId)).toMatchObject({ eur_rate: 10_000, eur_cents: 5, rate_source: 'test' })
    expect(await requestOf(agent, paid.body.requestId)).toMatchObject({ eurCents: 5, eurRate: 10_000, rateSource: 'test' })

    // 10 001 €/BSV: 5.0005 cents, rounded up to 6: over the maximum.
    setRate(10_001)
    const denied = await h.pay(agent, report())
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/^0\.06 € \(500 sats at 1 BSV = 10001 €\) is over the maximum per payment \(0\.05 €\)/) })
    // Recorded with its rate too, for accounting.
    expect(await row(denied.body.requestId)).toMatchObject({ eur_cents: 6, eur_rate: 10_001, price_sats: REPORT_PRICE_SATS })
  })

  it('a missing or stale rate denies the payment (fail closed)', async () => {
    const agent = await h.createAgent('eur-no-rate', eurRules(), 20_000)
    setRate(undefined)
    const none = await h.pay(agent, report())
    expect([none.status, none.body.reason]).toEqual([403, 'exchange rate unavailable'])
    setRate(10_000, MAX_RATE_AGE_MS + 1_000)
    const stale = await h.pay(agent, report())
    expect([stale.status, stale.body.reason]).toEqual([403, 'exchange rate unavailable'])
    expect(await row(stale.body.requestId)).toMatchObject({ eur_rate: null, eur_cents: null, rate_source: null })
    setRate(10_000, MAX_RATE_AGE_MS - 5_000)
    expect((await h.payAndSign(agent, report(), REPORT_PRICE_SATS)).body.status).toBe('paid')
  })

  it('the daily EUR budget sums the cents stored at payment time, not today\'s rate', async () => {
    const agent = await h.createAgent('eur-daily', eurRules(), 20_000)
    setRate(10_000)
    for (let i = 0; i < 2; i++) expect((await h.payAndSign(agent, report(), REPORT_PRICE_SATS)).body.status).toBe('paid')
    expect((await h.call('/v1/budget', agent.key)).body).toMatchObject({ currency: 'EUR', spentTodayCents: 10, remainingTodayCents: 2, spentTodaySats: 1_000, remainingTodaySats: 200 })

    // BSV halves: the report is now 2.5 → 3 cents. Converted at today's rate the 1 000 sats spent would be
    // only 5 cents (5 + 3 ≤ 12), but the stored 10 cents count: 10 + 3 > 12.
    setRate(5_000)
    const denied = await h.pay(agent, report())
    expect(denied.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/would exceed the daily budget \(0\.10 € of 0\.12 € spent today\)/) })
  })

  it('an approved payment is judged again at execute time, with the rate at that moment', async () => {
    const rules = eurRules({ maxPerPaymentCents: 30, dailyBudgetCents: 100, approvalThresholdCents: 10 })
    const agent = await h.createAgent('eur-approval', rules, 20_000)
    // 2 000 sats at 10 000 €/BSV = 20 cents: above the threshold, under the maximum.
    setRate(10_000)
    const pending = await h.pay(agent, hotel())
    expect(pending.status).toBe(202)
    const id = pending.body.requestId
    expect(await row(id)).toMatchObject({ eur_cents: 20 })
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))

    // BSV doubles before the agent executes: 40 cents, over the 30-cent maximum.
    setRate(20_000)
    const exec = await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })
    expect(exec.status).toBe(403)
    expect(exec.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/^0\.40 € .* over the maximum per payment \(0\.30 €\)/) })

    // A second approval, executed while the rate is unavailable: denied too.
    setRate(10_000)
    const second = (await h.pay(agent, hotel())).body.requestId
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, second, fp(agent))
    setRate(undefined)
    const noRate = await h.call(`/v1/requests/${second}/execute`, agent.key, { method: 'POST' })
    expect([noRate.status, noRate.body.reason]).toEqual([403, 'exchange rate unavailable'])

    // A third, executed at a slightly lower rate: allowed, and the ledger keeps the rate at payment time.
    setRate(10_000)
    const third = (await h.pay(agent, hotel())).body.requestId
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, third, fp(agent))
    setRate(9_000)
    const ok = await h.call(`/v1/requests/${third}/execute`, agent.key, { method: 'POST' })
    expect(ok.body.status).toBe('sign')
    const paid = await h.sign(agent, ok.body, ROOM_RATES_SATS.standard)
    expect(paid.body.status).toBe('paid')
    expect(await row(third)).toMatchObject({ eur_rate: 9_000, eur_cents: 18 })
    const entry = (await h.admin('/admin/ledger')).body.entries.find((e: any) => e.requestId === third)
    expect(entry).toMatchObject({ satoshis: ROOM_RATES_SATS.standard, eurCents: 18, eurRate: 9_000, rateSource: 'test' })
  })
})

describe('SAT agents', () => {
  it('are unchanged, with or without a rate; the rate is recorded when there is one', async () => {
    const agent = await h.createAgent('sat-bot', { allowedHosts: [merchantHost], maxPerPaymentSats: 600, dailyBudgetSats: 1_000, approvalThresholdSats: 600 }, 20_000)
    setRate(undefined)
    const a = await h.payAndSign(agent, report(), REPORT_PRICE_SATS)
    expect(a.body.status).toBe('paid')
    expect(await row(a.body.requestId)).toMatchObject({ eur_rate: null, eur_cents: null })
    setRate(10_000)
    const b = await h.payAndSign(agent, report(), REPORT_PRICE_SATS)
    expect(b.body.status).toBe('paid')
    expect(await row(b.body.requestId)).toMatchObject({ eur_rate: 10_000, eur_cents: 5, rate_source: 'test' })
    // The daily budget is still in sats: 1 000 spent of 1 000.
    expect((await h.pay(agent, report())).body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/500 sats would exceed the daily budget \(1000 of 1000 spent today\)/) })
    expect((await h.call('/v1/budget', agent.key)).body).toMatchObject({ currency: 'SAT', spentTodaySats: 1_000, remainingTodaySats: 0 })
  })
})

describe('the admin API and the dashboard', () => {
  it('EUR rules round-trip through the API and the dashboard\'s form', async () => {
    const created = await h.admin('/admin/agents', { method: 'POST', body: { name: 'eur-form', rules: { allowedHosts: [merchantHost], currency: 'EUR', maxPerPaymentCents: 50, dailyBudgetCents: 500, approvalThresholdCents: 20 } } })
    expect(created.status).toBe(201)
    const listed = async (): Promise<any> => (await h.admin('/admin/agents')).body.agents.find((a: any) => a.id === created.body.id).rules
    expect(await listed()).toEqual(created.body.rules)

    // What the form shows, edited as an admin would ("0.75 €"), then saved.
    const form = { ...rulesToForm(await listed()), maxPerPayment: '0.75' }
    expect(form).toMatchObject({ currency: 'EUR', maxPerPayment: '0.75', dailyBudget: '5.00', approvalThreshold: '0.20' })
    const put = await h.admin(`/admin/agents/${created.body.id as string}/rules`, { method: 'PUT', body: formToRules(form) })
    expect(put.status).toBe(200)
    expect(await listed()).toEqual({ allowedHosts: [merchantHost], currency: 'EUR', maxPerPaymentCents: 75, dailyBudgetCents: 500, approvalThresholdCents: 20 })
    expect(formToRules(rulesToForm(await listed()))).toEqual(await listed())

    // Back to sats.
    await h.admin(`/admin/agents/${created.body.id as string}/rules`, { method: 'PUT', body: { allowedHosts: [], maxPerPaymentSats: 1, dailyBudgetSats: 2, approvalThresholdSats: 0 } })
    expect(await listed()).toEqual({ allowedHosts: [], currency: 'SAT', maxPerPaymentSats: 1, dailyBudgetSats: 2, approvalThresholdSats: 0 })
    expect((await h.admin(`/admin/agents/${created.body.id as string}/rules`, { method: 'PUT', body: { allowedHosts: [], currency: 'EUR', maxPerPaymentCents: 0.5, dailyBudgetCents: 1, approvalThresholdCents: 0 } })).status).toBe(400)
  })

  it('shows the current rate', async () => {
    setRate(41.5)
    expect((await h.admin('/admin/rate')).body).toMatchObject({ available: true, rate: 41.5, source: 'test', at: expect.any(String) })
    setRate(41.5, MAX_RATE_AGE_MS + 1)
    expect((await h.admin('/admin/rate')).body).toMatchObject({ available: false, rate: 41.5 })
    setRate(undefined)
    expect((await h.admin('/admin/rate')).body).toEqual({ available: false })
  })
})

describe('the agent tools', () => {
  it('check_budget and get_price speak euros under EUR rules', async () => {
    const created = await h.newAgent('eur-tools', eurRules({ maxPerPaymentCents: 50, dailyBudgetCents: 120, approvalThresholdCents: 20 }))
    const tools = createAgentTools({ client: new ProxyClient({ proxyUrl: h.url, apiKey: created.apiKey }) })
    setRate(10_000)
    const budget = await tools.checkBudget()
    expect(budget.summary).toMatch(/^Budget in euros\. Remaining today: 1\.20 € of 1\.20 €\. About 12000 sats at 1 BSV = 10000 € \(test\)\./)
    expect(budget.summary).toMatch(/above 0\.20 € need a human approval; above 0\.50 € they are refused/)
    const price = await tools.getPrice({ url: `${merchant}/api/report`, method: 'GET' })
    expect(price.summary).toBe('The merchant asks 500 sats for this request. That is about 0.05 € at 1 BSV = 10000 € (test); your budget is in euros and the price is converted again at payment time.')
    expect(price.data).toMatchObject({ satoshis: 500, eurCents: 5, eurRate: 10_000 })

    setRate(undefined)
    expect((await tools.checkBudget()).summary).toMatch(/exchange rate is unavailable right now, so every payment is refused/)
    expect((await tools.getPrice({ url: `${merchant}/api/report`, method: 'GET' })).summary).toMatch(/exchange rate is unavailable right now: the payment would be refused/)
  })
})

describe('vault v2 under EUR rules', () => {
  it('funding sets MAX_SATS = ceil(euro maximum at the funding-time rate x 1.5); the euro limit stays in the policy', async () => {
    const v2 = await createProxyHarness({ app: { vaultCovenant: true, rates } })
    try {
      const m = await v2.listen(createMerchantApp(await v2.chain.makeWallet()))
      const rules = { allowedHosts: [new URL(m).host], currency: 'EUR', maxPerPaymentCents: 50, dailyBudgetCents: 500, approvalThresholdCents: 50 }
      const agent = await v2.createAgent('eur-v2', rules)

      setRate(undefined)
      await expect(getVaultParams(v2.url, ADMIN_TOKEN, agent.id)).rejects.toThrow(/exchange rate unavailable/)

      // 1 BSV = 7 000 €: 50 cents = 7 142.857 sats; x 1.5 = 10 714.29 → 10 715.
      setRate(7_000)
      const params = await getVaultParams(v2.url, ADMIN_TOKEN, agent.id)
      expect(params.covenant).toEqual({ maxSats: 10_715, maxFeeSats: 1_000 })
      expect(params.policy).toEqual({ currency: 'EUR', maxPerPaymentCents: 50 })
      await fundVault(v2.company, v2.url, ADMIN_TOKEN, agent.id, 30_000, fp(agent))

      // The rate moves after funding: the ceiling on chain does not.
      setRate(9_000)
      const listed = (await v2.admin('/admin/vaults')).body.vaults.find((v: any) => v.agentId === agent.id)
      expect(listed).toMatchObject({ status: 'open', covenant: { maxSats: 10_715, maxFeeSats: 1_000 }, policy: { currency: 'EUR', maxPerPaymentCents: 50 } })
      // The exact euro limit is the policy's: 500 sats at 9 000 €/BSV = 4.5 → 5 cents, paid.
      expect((await v2.payAndSign(agent, { url: `${m}/api/report`, purpose: 'Report' }, REPORT_PRICE_SATS)).body.status).toBe('paid')
    } finally {
      await v2.close()
    }
  })
})
