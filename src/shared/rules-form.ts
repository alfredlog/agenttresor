/**
 * The dashboard's rules form ↔ the rules JSON of the admin API. EUR limits
 * are typed in euros ("0.50") and sent as integer cents; SAT limits are
 * whole satoshis. Bundled for the browser as public/rules-form.js
 * (npm run build:web).
 */

export type FormCurrency = 'SAT' | 'EUR'

/** What the form's fields hold (strings, as inputs do). */
export interface RulesFormValues {
  currency: FormCurrency
  allowedHosts: string
  maxPerPayment: string
  dailyBudget: string
  approvalThreshold: string
}

const LIMITS = ['maxPerPayment', 'dailyBudget', 'approvalThreshold'] as const

/** "0.50 €" */
export const formatEur = (cents: number): string => `${(cents / 100).toFixed(2)} €`

/** "0.50" → 50; "2" → 200; NaN for anything that is not a non-negative amount with at most 2 decimals. */
export function eurosToCents (euros: string): number {
  const m = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(euros)
  if (m === null) return Number.NaN
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

/** The form fields for some rules (from GET /admin/agents). */
export function rulesToForm (rules: any): RulesFormValues {
  const eur = rules.currency === 'EUR'
  const value = (k: typeof LIMITS[number]): string =>
    eur ? (Number(rules[`${k}Cents`]) / 100).toFixed(2) : String(rules[`${k}Sats`])
  return {
    currency: eur ? 'EUR' : 'SAT',
    allowedHosts: (rules.allowedHosts as string[]).join(', '),
    maxPerPayment: value('maxPerPayment'),
    dailyBudget: value('dailyBudget'),
    approvalThreshold: value('approvalThreshold')
  }
}

/** The rules JSON for the admin API; the proxy validates it again. */
export function formToRules (f: RulesFormValues): Record<string, unknown> {
  const rules: Record<string, unknown> = {
    allowedHosts: f.allowedHosts.split(',').map(h => h.trim()).filter(h => h !== ''),
    currency: f.currency
  }
  for (const k of LIMITS) {
    if (f.currency === 'EUR') rules[`${k}Cents`] = eurosToCents(f[k])
    else rules[`${k}Sats`] = Number(f[k])
  }
  return rules
}

/** One line for the agents table: "max 0.50 € · daily 5.00 € · approval above 0.20 €". */
export function rulesSummary (rules: any): string {
  if (rules.currency === 'EUR') {
    return `max ${formatEur(rules.maxPerPaymentCents)} · daily ${formatEur(rules.dailyBudgetCents)} · approval above ${formatEur(rules.approvalThresholdCents)}`
  }
  return `max ${String(rules.maxPerPaymentSats)} · daily ${String(rules.dailyBudgetSats)} · approval above ${String(rules.approvalThresholdSats)} sats`
}

/** "1 BSV = 41.23 € (coingecko, 14:02:10)", from GET /admin/rate. */
export function rateLine (r: { available?: boolean, rate?: number, at?: string, source?: string }): string {
  if (r.rate === undefined) return 'BSV/EUR rate unavailable: payments under euro budgets are refused'
  const at = r.at === undefined ? '' : `, ${new Date(r.at).toLocaleTimeString()}`
  return `1 BSV = ${r.rate.toFixed(2)} € (${r.source ?? 'unknown'}${at})${r.available === false ? ' — too old: payments under euro budgets are refused' : ''}`
}
