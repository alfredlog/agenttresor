/**
 * The company's spending rules for one agent, and the pure decision function
 * applied to every price the proxy is asked to pay.
 */
export interface Rules {
  /** Merchant hosts the agent may pay: "api.example.com" (any port) or "localhost:5080" (that port only). */
  allowedHosts: string[]
  maxPerPaymentSats: number
  dailyBudgetSats: number
  /** Payments above this need a human approval. */
  approvalThresholdSats: number
}

export type Decision =
  | { decision: 'allow' }
  | { decision: 'needs_approval' }
  | { decision: 'deny', reason: string }

/** New agents may pay nothing until an admin sets their rules. */
export const DEFAULT_RULES: Rules = { allowedHosts: [], maxPerPaymentSats: 0, dailyBudgetSats: 0, approvalThresholdSats: 0 }

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
 * spent today. Deny rules come first, so a payment needing approval is always
 * one the rules would otherwise allow.
 */
export function evaluate (rules: Rules, spentToday: number, host: string, sats: number): Decision {
  if (!hostAllowed(rules, host)) return { decision: 'deny', reason: `host ${host} is not allowed` }
  if (sats > rules.maxPerPaymentSats) {
    return { decision: 'deny', reason: `${sats} sats is over the maximum per payment (${rules.maxPerPaymentSats})` }
  }
  if (spentToday + sats > rules.dailyBudgetSats) {
    return { decision: 'deny', reason: `${sats} sats would exceed the daily budget (${spentToday} of ${rules.dailyBudgetSats} spent today)` }
  }
  if (sats > rules.approvalThresholdSats) return { decision: 'needs_approval' }
  return { decision: 'allow' }
}

const isSats = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Validates rules from an admin request; returns an error message or the rules. */
export function parseRules (input: unknown): Rules | string {
  const r = (input ?? {}) as Record<string, unknown>
  if (!Array.isArray(r.allowedHosts) || !r.allowedHosts.every(h => typeof h === 'string' && /^[a-z0-9.\-[\]:]+$/i.test(h))) {
    return 'allowedHosts must be an array of hosts ("api.example.com" or "localhost:5080")'
  }
  for (const k of ['maxPerPaymentSats', 'dailyBudgetSats', 'approvalThresholdSats'] as const) {
    if (!isSats(r[k])) return `${k} must be a non-negative integer (satoshis)`
  }
  return {
    allowedHosts: r.allowedHosts as string[],
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
