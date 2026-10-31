/**
 * Budgets in euros, the pure parts: the rate provider (cache, timeout, last
 * good quote), sats → cents rounding up, EUR rules at the boundary, a missing
 * or stale rate (fail closed), the v2 ceiling and the dashboard's form.
 */
import { describe, expect, it } from 'vitest'
import { covenantMaxSats, evaluate, parseRules, RATE_UNAVAILABLE, type Rules } from '../src/proxy/rules'
import { cachedRateProvider, centsToSats, coingeckoQuote, COINGECKO_URL, freshQuote, MAX_RATE_AGE_MS, satsToCents, type RateQuote } from '../src/shared/rate'
import { budgetSummary } from '../src/agent/tools'
import { eurosToCents, formToRules, rateLine, rulesSummary, rulesToForm } from '../src/shared/rules-form'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const quote = (rate: number, ageMs = 0): RateQuote => ({ rate, at: NOW - ageMs, source: 'test' })
const eur: Rules = { allowedHosts: ['api.example.com'], currency: 'EUR', maxPerPaymentCents: 50, dailyBudgetCents: 120, approvalThresholdCents: 20 }
const host = 'api.example.com'

describe('sats → euro cents', () => {
  it('rounds up, never down', () => {
    // 1 BSV = 10 000 €: 1 sat = 0.01 cent.
    expect(satsToCents(5_000, 10_000)).toBe(50)
    expect(satsToCents(5_001, 10_000)).toBe(51)
    expect(satsToCents(1, 10_000)).toBe(1)
    expect(satsToCents(0, 10_000)).toBe(0)
    expect(satsToCents(500, 10_001)).toBe(6) // 5.0005 cents
  })

  it('a whole number of cents is not pushed up by float noise', () => {
    // 0.1 + 0.2 style noise: 3 sats at 1 BSV = 33 333 333.333… € is 100 cents (minus noise).
    expect(satsToCents(3, 100_000_000 / 3)).toBe(100)
    expect(satsToCents(1_000, 41.1)).toBe(1) // 0.000411 cent
    expect(satsToCents(100_000_000, 41.1)).toBe(4_110)
  })

  it('converts cents back to sats', () => {
    expect(centsToSats(50, 10_000)).toBe(5_000)
  })
})

describe('evaluate() with EUR rules', () => {
  it('allows exactly the maximum per payment, denies one cent above (with a fixed rate)', () => {
    const ctx = { quote: quote(10_000), now: NOW }
    expect(evaluate({ ...eur, approvalThresholdCents: 50 }, 0, host, 5_000, ctx)).toEqual({ decision: 'allow' })
    expect(evaluate(eur, 0, host, 5_001, ctx)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/^0\.51 € \(5001 sats at 1 BSV = 10000 €\) is over the maximum per payment \(0\.50 €\)/) })
  })

  it('rounding up decides at the boundary', () => {
    // 500 sats at 10 001 €/BSV is 5.0005 cents: 6 cents, over a 5-cent maximum.
    const tight: Rules = { ...eur, maxPerPaymentCents: 5, approvalThresholdCents: 5 }
    expect(evaluate(tight, 0, host, 500, { quote: quote(10_000), now: NOW })).toEqual({ decision: 'allow' })
    expect(evaluate(tight, 0, host, 500, { quote: quote(10_001), now: NOW })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/^0\.06 €/) })
  })

  it('applies the daily budget and the approval threshold in cents', () => {
    const ctx = { quote: quote(10_000), now: NOW }
    expect(evaluate(eur, 100, host, 2_000, ctx)).toEqual({ decision: 'allow' }) // 100 + 20 = 120
    expect(evaluate(eur, 101, host, 2_000, ctx)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/daily budget \(1\.01 € of 1\.20 € spent today\)/) })
    expect(evaluate(eur, 0, host, 2_001, ctx)).toEqual({ decision: 'needs_approval' }) // 21 cents
  })

  it('fails closed without a rate, or with one older than 5 minutes', () => {
    const deny = { decision: 'deny', reason: RATE_UNAVAILABLE }
    expect(evaluate(eur, 0, host, 1, undefined)).toEqual(deny)
    expect(evaluate(eur, 0, host, 1, { now: NOW })).toEqual(deny)
    expect(evaluate(eur, 0, host, 1, { quote: quote(10_000, MAX_RATE_AGE_MS + 1), now: NOW })).toEqual(deny)
    expect(evaluate(eur, 0, host, 1, { quote: quote(0), now: NOW })).toEqual(deny)
    expect(evaluate(eur, 0, host, 1, { quote: quote(10_000, MAX_RATE_AGE_MS), now: NOW })).toEqual({ decision: 'allow' })
    // The host check still comes first.
    expect(evaluate(eur, 0, 'evil.example', 1, undefined)).toMatchObject({ reason: 'host evil.example is not allowed' })
  })

  it('SAT rules ignore the rate entirely', () => {
    const sat: Rules = { allowedHosts: [host], maxPerPaymentSats: 1_000, dailyBudgetSats: 2_000, approvalThresholdSats: 500 }
    expect(evaluate(sat, 0, host, 400, undefined)).toEqual({ decision: 'allow' })
    expect(evaluate(sat, 0, host, 400, { now: NOW })).toEqual({ decision: 'allow' })
  })
})

describe('the v2 on-chain ceiling under EUR rules', () => {
  it('is ceil(euro maximum converted at funding time x 1.5)', () => {
    expect(covenantMaxSats(eur, { quote: quote(30_000), now: NOW })).toBe(2_500) // 50 cents = 1666.67 sats x 1.5
    expect(covenantMaxSats(eur, { quote: quote(7_000), now: NOW })).toBe(10_715) // 7142.857 x 1.5 = 10714.29
    expect(covenantMaxSats(eur, { quote: quote(30_000, MAX_RATE_AGE_MS + 1), now: NOW })).toBeUndefined()
    expect(covenantMaxSats({ allowedHosts: [], maxPerPaymentSats: 777, dailyBudgetSats: 0, approvalThresholdSats: 0 }, { now: NOW })).toBe(777)
  })
})

describe('parseRules() with a currency', () => {
  it('accepts EUR rules in integer cents and rejects bad ones', () => {
    expect(parseRules(eur)).toEqual(eur)
    expect(parseRules({ ...eur, maxPerPaymentCents: 0.5 })).toMatch(/maxPerPaymentCents must be a non-negative integer \(euro cents\)/)
    expect(parseRules({ ...eur, dailyBudgetCents: undefined, dailyBudgetSats: 5 })).toMatch(/dailyBudgetCents/)
    expect(parseRules({ ...eur, currency: 'USD' })).toMatch(/currency must be/)
  })
})

describe('the rate provider', () => {
  it('reads CoinGecko\'s simple price for Bitcoin SV in EUR', async () => {
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ 'bitcoin-cash-sv': { eur: 41.23, last_updated_at: NOW / 1000 } }))
    }) as unknown as typeof fetch
    expect(await coingeckoQuote(fake)()).toEqual({ rate: 41.23, at: NOW, source: 'coingecko' })
    expect(seen).toEqual([COINGECKO_URL])
    const empty = (async () => new Response('{}')) as unknown as typeof fetch
    await expect(coingeckoQuote(empty)()).rejects.toThrow(/no BSV\/EUR rate/)
  })

  it('times out after 5 s', async () => {
    const hang = (async (_url: string, init: RequestInit) => await new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(init.signal?.reason) })
    })) as unknown as typeof fetch
    await expect(coingeckoQuote(hang, 20)()).rejects.toThrow(/timeout|aborted/i)
  })

  it('caches a quote for 60 s, keeps the last good one when a fetch fails, and retries after 15 s', async () => {
    let t = NOW
    let calls = 0
    let fail = false
    const provider = cachedRateProvider({
      now: () => t,
      fetchQuote: async () => {
        calls++
        if (fail) throw new Error('down')
        return { rate: 40 + calls, at: t, source: 'test' }
      }
    })
    expect((await provider.current())?.rate).toBe(41)
    t += 59_000
    expect((await provider.current())?.rate).toBe(41)
    expect(calls).toBe(1)
    t += 2_000
    expect((await provider.current())?.rate).toBe(42)
    fail = true
    t += 61_000
    const last = await provider.current()
    expect([last?.rate, calls]).toEqual([42, 3])
    // The caller judges freshness: this quote is now 61 s old, still usable; 5 minutes later it is not.
    expect(freshQuote(last, t)).toBe(true)
    expect(freshQuote(last, t + MAX_RATE_AGE_MS)).toBe(false)
    t += 10_000
    await provider.current()
    expect(calls).toBe(3) // no retry within 15 s of a failure
    fail = false
    t += 6_000
    expect((await provider.current())?.rate).toBe(44)
  })

  it('without any quote yet, a failing source gives undefined', async () => {
    const provider = cachedRateProvider({ fetchQuote: async () => { throw new Error('down') } })
    expect(await provider.current()).toBeUndefined()
  })
})

describe('the dashboard\'s rules form', () => {
  it('shows EUR limits as euros and sends them as cents, round trip', () => {
    expect(rulesToForm(eur)).toEqual({ currency: 'EUR', allowedHosts: 'api.example.com', maxPerPayment: '0.50', dailyBudget: '1.20', approvalThreshold: '0.20' })
    expect(formToRules(rulesToForm(eur))).toEqual(eur)
    const sat = { allowedHosts: ['a.example', 'localhost:5080'], currency: 'SAT', maxPerPaymentSats: 1_000, dailyBudgetSats: 5_000, approvalThresholdSats: 300 }
    expect(formToRules(rulesToForm(sat))).toEqual(sat)
    expect(rulesSummary(eur)).toBe('max 0.50 € · daily 1.20 € · approval above 0.20 €')
    expect(rulesSummary(sat)).toBe('max 1000 · daily 5000 · approval above 300 sats')
  })

  it('reads euros exactly, without float rounding', () => {
    expect(eurosToCents('0.50')).toBe(50)
    expect(eurosToCents('0,5')).toBe(50)
    expect(eurosToCents('2')).toBe(200)
    expect(eurosToCents('1.15')).toBe(115) // 1.15 * 100 is 114.99999999999999 in floats
    expect(eurosToCents('1.155')).toBeNaN()
    expect(eurosToCents('-1')).toBeNaN()
  })

  it('shows the rate line', () => {
    expect(rateLine({ available: true, rate: 41.234, at: new Date(NOW).toISOString(), source: 'coingecko' })).toMatch(/^1 BSV = 41\.23 € \(coingecko, .+\)$/)
    expect(rateLine({ available: false })).toMatch(/unavailable/)
    expect(rateLine({ available: false, rate: 41, source: 'coingecko' })).toMatch(/too old/)
  })
})

describe('check_budget text', () => {
  const eurRules = { allowedHosts: [], currency: 'EUR', maxPerPaymentCents: 50, dailyBudgetCents: 50, approvalThresholdCents: 20 }
  it('EUR rules: euro amounts only, never undefined or NaN', () => {
    const full = budgetSummary({ rules: eurRules, spentTodayCents: 1, remainingTodayCents: 49, remainingTodaySats: 4_900, spentTodaySats: 100, rate: { rate: 10_000, source: 'test' }, vault: { satoshis: 20_000, status: 'open' } })
    expect(full).toMatch(/^Budget in euros: 0\.49 € left today of 0\.50 € \(0\.01 € spent\); approval above 0\.20 €; max 0\.50 € per payment\./)
    // Sparse answers (older proxy, no rate): still no "undefined" or "NaN", and no sat limits.
    for (const b of [{ rules: eurRules, spentTodayCents: 1, rate: null, vault: { satoshis: 0, status: 'none' } }, { rules: eurRules }]) {
      const text = budgetSummary(b)
      expect(text).not.toMatch(/undefined|NaN/)
      expect(text).toMatch(/approval above 0\.20 €; max 0\.50 € per payment/)
    }
    expect(budgetSummary({ rules: eurRules, spentTodayCents: 1 })).toMatch(/0\.49 € left today/)
  })
  it('SAT rules: unchanged', () => {
    expect(budgetSummary({ rules: { allowedHosts: [], maxPerPaymentSats: 1_000, dailyBudgetSats: 5_000, approvalThresholdSats: 300 }, remainingTodaySats: 4_500, vault: { satoshis: 20_000, status: 'open' } }))
      .toBe('Remaining today: 4500 of 5000 sats; vault: 20000 sats (open). Payments above 300 sats need a human approval; above 1000 sats they are refused.')
  })
})
