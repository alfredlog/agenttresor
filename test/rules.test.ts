import { describe, expect, it } from 'vitest'
import { dayStart, evaluate, hostAllowed, parseRules, type Rules } from '../src/proxy/rules'

const rules: Rules = { allowedHosts: ['api.example.com', 'localhost:5080'], maxPerPaymentSats: 10_000, dailyBudgetSats: 20_000, approvalThresholdSats: 1_000 }

describe('evaluate()', () => {
  it('allows a payment to an allowed host under every limit', () => {
    expect(evaluate(rules, 0, 'api.example.com', 1_000)).toEqual({ decision: 'allow' })
  })

  it('denies a host that is not allowed', () => {
    expect(evaluate(rules, 0, 'evil.example.com', 1)).toEqual({ decision: 'deny', reason: 'host evil.example.com is not allowed' })
  })

  it('matches a host without port on any port, a host with port only on that port', () => {
    expect(hostAllowed(rules, 'api.example.com:8443')).toBe(true)
    expect(hostAllowed(rules, 'localhost:5080')).toBe(true)
    expect(hostAllowed(rules, 'localhost:5081')).toBe(false)
    expect(hostAllowed(rules, 'API.Example.com')).toBe(true)
  })

  it('denies over the maximum per payment', () => {
    const d = evaluate(rules, 0, 'api.example.com', 10_001)
    expect(d).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/maximum per payment/) })
  })

  it('denies over the daily budget, counting what was already spent', () => {
    expect(evaluate(rules, 19_500, 'api.example.com', 500)).toEqual({ decision: 'allow' })
    expect(evaluate(rules, 19_501, 'api.example.com', 500)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/daily budget/) })
  })

  it('needs approval strictly above the threshold', () => {
    expect(evaluate(rules, 0, 'api.example.com', 1_000)).toEqual({ decision: 'allow' })
    expect(evaluate(rules, 0, 'api.example.com', 1_001)).toEqual({ decision: 'needs_approval' })
  })

  it('denies before asking for approval', () => {
    expect(evaluate(rules, 0, 'api.example.com', 50_000).decision).toBe('deny')
    expect(evaluate(rules, 19_000, 'api.example.com', 5_000).decision).toBe('deny')
    expect(evaluate(rules, 0, 'other.example.com', 5_000).decision).toBe('deny')
  })

  it('allows nothing with zero limits', () => {
    expect(evaluate({ ...rules, maxPerPaymentSats: 0 }, 0, 'api.example.com', 1).decision).toBe('deny')
  })
})

describe('parseRules() and dayStart()', () => {
  it('accepts valid rules and rejects bad ones', () => {
    expect(parseRules(rules)).toEqual(rules)
    expect(parseRules({ ...rules, allowedHosts: 'api.example.com' })).toMatch(/allowedHosts/)
    expect(parseRules({ ...rules, dailyBudgetSats: -1 })).toMatch(/dailyBudgetSats/)
    expect(parseRules({ ...rules, maxPerPaymentSats: 1.5 })).toMatch(/maxPerPaymentSats/)
  })

  it('starts the budget day at 00:00 UTC', () => {
    expect(dayStart(Date.parse('2026-10-30T17:45:00Z'))).toBe(Date.parse('2026-10-30T00:00:00Z'))
  })
})
