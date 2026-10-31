/**
 * The company's spending rules for one agent, and the pure decision function
 * applied to every price the proxy is asked to pay.
 *
 * Limits are in satoshis (currency 'SAT', the default) or in euro cents
 * (currency 'EUR'). Payments are always in satoshis: under EUR rules the
 * merchant's price is converted at the current BSV/EUR rate, rounded up, and a
 * missing or stale rate denies the payment (fail closed).
 */
import { centsToSats, formatCents, freshQuote, satsToCents, type RateQuote } from '../shared/rate.js'

export type Currency = 'SAT' | 'EUR'

interface RulesBase {
  /** Merchant hosts the agent may pay: "api.example.com" (any port) or "localhost:5080" (that port only). */
  allowedHosts: string[]
}

export interface SatRules extends RulesBase {
  /** Absent in rules from before currencies existed: those are 'SAT'. */
  currency?: 'SAT'
  maxPerPaymentSats: number
  dailyBudgetSats: number
  /** Payments above this need a human approval. */
  approvalThresholdSats: number
}

/** Stable budgets: limits in integer euro cents. */
export interface EurRules extends RulesBase {
  currency: 'EUR'
  maxPerPaymentCents: number
  dailyBudgetCents: number
  /** Payments above this need a human approval. */
  approvalThresholdCents: number
}

export type Rules = SatRules | EurRules

export const isEur = (rules: Rules): rules is EurRules => rules.currency === 'EUR'

/** The rate a decision under EUR rules converts with, and the time it is judged at. */
export interface PriceContext {
  quote?: RateQuote
  now: number
}

export const RATE_UNAVAILABLE = 'exchange rate unavailable'

/** Headroom of a v2 vault's on-chain ceiling over the euro maximum at funding time (the rate may rise). */
export const EUR_CEILING_FACTOR = 1.5

/**
 * MAX_SATS of a NEW v2 vault: the maximum per payment in sats, or for EUR rules
 * the euro maximum converted at the current rate x 1.5, rounded up. That is a
 * hard on-chain ceiling; the exact euro limit stays in the policy. Undefined
 * under EUR rules without a fresh rate.
 */
export function covenantMaxSats (rules: Rules, ctx: PriceContext): number | undefined {
  if (!isEur(rules)) return rules.maxPerPaymentSats
  if (!freshQuote(ctx.quote, ctx.now)) return undefined
  // x 1.5 on the (integer) cents first: one division, so a whole number of sats is not pushed up by float noise.
  return Math.ceil(centsToSats(rules.maxPerPaymentCents * EUR_CEILING_FACTOR, ctx.quote.rate))
}

export type Decision =
  | { decision: 'allow' }
  | { decision: 'needs_approval' }
  | { decision: 'deny', reason: string }

/** New agents may pay nothing until an admin sets their rules. */
export const DEFAULT_RULES: Rules = { allowedHosts: [], currency: 'SAT', maxPerPaymentSats: 0, dailyBudgetSats: 0, approvalThresholdSats: 0 }

/** `host` is a URL host (hostname[:port]), as in `new URL(url).host`. */
export function hostAllowed (rules: Rules, host: string): boolean {
  const h = host.toLowerCase()
  const hostname = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
  return rules.allowedHosts.some(entry => {
    const e = entry.toLowerCase()
    return e === h || e === hostname
  })
}

/**
 * Decides one payment of `sats` to `host`, given what the agent has already
 * spent today (in the rules' unit: satoshis, or euro cents for EUR rules).
 * Deny rules come first, so a payment needing approval is always one the rules
 * would otherwise allow. EUR rules need `ctx` with a quote at most 5 minutes old.
 */
export function evaluate (rules: Rules, spentToday: number, host: string, sats: number, ctx?: PriceContext): Decision {
  if (!hostAllowed(rules, host)) return { decision: 'deny', reason: `host ${host} is not allowed` }
  if (isEur(rules)) return evaluateEur(rules, spentToday, sats, ctx)
  if (sats > rules.maxPerPaymentSats) {
    return { decision: 'deny', reason: `${sats} sats is over the maximum per payment (${rules.maxPerPaymentSats})` }
  }
  if (spentToday + sats > rules.dailyBudgetSats) {
    return { decision: 'deny', reason: `${sats} sats would exceed the daily budget (${spentToday} of ${rules.dailyBudgetSats} spent today)` }
  }
  if (sats > rules.approvalThresholdSats) return { decision: 'needs_approval' }
  return { decision: 'allow' }
}

function evaluateEur (rules: EurRules, spentCents: number, sats: number, ctx: PriceContext | undefined): Decision {
  if (ctx === undefined || !freshQuote(ctx.quote, ctx.now)) return { decision: 'deny', reason: RATE_UNAVAILABLE }
  const cents = satsToCents(sats, ctx.quote.rate)
  const price = `${formatCents(cents)} (${sats} sats at 1 BSV = ${ctx.quote.rate} €)`
  if (cents > rules.maxPerPaymentCents) {
    return { decision: 'deny', reason: `${price} is over the maximum per payment (${formatCents(rules.maxPerPaymentCents)})` }
  }
  if (spentCents + cents > rules.dailyBudgetCents) {
    return { decision: 'deny', reason: `${price} would exceed the daily budget (${formatCents(spentCents)} of ${formatCents(rules.dailyBudgetCents)} spent today)` }
  }
  if (cents > rules.approvalThresholdCents) return { decision: 'needs_approval' }
  return { decision: 'allow' }
}

const isAmount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Validates rules from an admin request; returns an error message or the rules. Without `currency`, the rules are in satoshis. */
export function parseRules (input: unknown): Rules | string {
  const r = (input ?? {}) as Record<string, unknown>
  if (!Array.isArray(r.allowedHosts) || !r.allowedHosts.every(h => typeof h === 'string' && /^[a-z0-9.\-[\]:]+$/i.test(h))) {
    return 'allowedHosts must be an array of hosts ("api.example.com" or "localhost:5080")'
  }
  const currency = r.currency ?? 'SAT'
  if (currency !== 'SAT' && currency !== 'EUR') return "currency must be 'SAT' or 'EUR'"
  if (currency === 'EUR') {
    for (const k of ['maxPerPaymentCents', 'dailyBudgetCents', 'approvalThresholdCents'] as const) {
      if (!isAmount(r[k])) return `${k} must be a non-negative integer (euro cents)`
    }
    return {
      allowedHosts: r.allowedHosts as string[],
      currency: 'EUR',
      maxPerPaymentCents: r.maxPerPaymentCents as number,
      dailyBudgetCents: r.dailyBudgetCents as number,
      approvalThresholdCents: r.approvalThresholdCents as number
    }
  }
  for (const k of ['maxPerPaymentSats', 'dailyBudgetSats', 'approvalThresholdSats'] as const) {
    if (!isAmount(r[k])) return `${k} must be a non-negative integer (satoshis)`
  }
  return {
    allowedHosts: r.allowedHosts as string[],
    currency: 'SAT',
    maxPerPaymentSats: r.maxPerPaymentSats as number,
    dailyBudgetSats: r.dailyBudgetSats as number,
    approvalThresholdSats: r.approvalThresholdSats as number
  }
}

const DAY_MS = 86_400_000

/** Budgets reset at 00:00 UTC. */
export function dayStart (nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS
}
