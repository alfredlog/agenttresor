/**
 * The BSV/EUR exchange rate, for budgets in euros. Payments stay in satoshis:
 * the rate only converts a merchant's price to euro cents when rules are in
 * EUR (and is recorded with every request, for accounting).
 *
 * The default source is CoinGecko's simple price for Bitcoin SV in EUR. A
 * quote is cached for 60 s, a fetch times out after 5 s, and a failed fetch is
 * not retried for 15 s; meanwhile the last good quote is returned, and the
 * caller decides whether it is too old (the proxy refuses quotes older than
 * 5 minutes: fail closed).
 */

export interface RateQuote {
  /** Euros per 1 BSV. */
  rate: number
  /** When the source last updated the rate (ms since epoch). */
  at: number
  /** Where it comes from, e.g. "coingecko". */
  source: string
}

export interface RateProvider {
  /** The current quote, or undefined if none was ever obtained. Never throws. */
  current: () => Promise<RateQuote | undefined>
}

/** A quote older than this is not used: payments under EUR rules are denied. */
export const MAX_RATE_AGE_MS = 5 * 60_000

export const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=eur&include_last_updated_at=true'

const SATS_PER_BSV = 100_000_000
// Float noise (e.g. 49.000000000001 cents) must not round a whole number of cents up.
const EPSILON = 1e-9

/** Euro cents for `sats` at `rate` €/BSV, rounded UP (a payment never looks cheaper than it is). */
export function satsToCents (sats: number, rate: number): number {
  // Math.max: ceil(0 - EPSILON) would be -0.
  return Math.max(0, Math.ceil(sats * rate * 100 / SATS_PER_BSV - EPSILON))
}

/** Satoshis worth `cents` at `rate` €/BSV (not rounded). */
export function centsToSats (cents: number, rate: number): number {
  return cents * SATS_PER_BSV / (rate * 100)
}

/** Whether a quote is present and recent enough to convert with. */
export function freshQuote (quote: RateQuote | undefined, nowMs: number): quote is RateQuote {
  return quote !== undefined && Number.isFinite(quote.rate) && quote.rate > 0 && nowMs - quote.at <= MAX_RATE_AGE_MS
}

/** "0.50 €" */
export function formatCents (cents: number): string {
  return `${(cents / 100).toFixed(2)} €`
}

/** Fetches one quote from CoinGecko; throws on any problem. */
export function coingeckoQuote (fetchFn: typeof fetch = fetch, timeoutMs = 5_000, now: () => number = Date.now): () => Promise<RateQuote> {
  return async () => {
    const res = await fetchFn(COINGECKO_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`)
    const body = await res.json() as { 'bitcoin-cash-sv'?: { eur?: unknown, last_updated_at?: unknown } }
    const entry = body['bitcoin-cash-sv']
    const rate = Number(entry?.eur)
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('CoinGecko sent no BSV/EUR rate')
    const updated = Number(entry?.last_updated_at)
    return { rate, at: Number.isFinite(updated) && updated > 0 ? updated * 1000 : now(), source: 'coingecko' }
  }
}

export interface CachedRateOptions {
  fetchQuote: () => Promise<RateQuote>
  /** How long a quote is reused (default 60 s). */
  ttlMs?: number
  /** How long after a failed fetch the next one is tried (default 15 s). */
  retryMs?: number
  now?: () => number
  log?: (msg: string) => void
}

/** A provider that caches the last good quote; concurrent callers share one fetch. */
export function cachedRateProvider (opts: CachedRateOptions): RateProvider {
  const ttlMs = opts.ttlMs ?? 60_000
  const retryMs = opts.retryMs ?? 15_000
  const now = opts.now ?? Date.now
  let last: RateQuote | undefined
  let fetchedAt = -Infinity
  let failedAt = -Infinity
  let inflight: Promise<RateQuote | undefined> | undefined

  return {
    current: async () => {
      const t = now()
      if (t - fetchedAt < ttlMs || t - failedAt < retryMs) return last
      inflight ??= opts.fetchQuote().then(q => {
        last = q
        fetchedAt = now()
        return q
      }, (err: unknown) => {
        failedAt = now()
        opts.log?.(`exchange rate unavailable: ${err instanceof Error ? err.message : String(err)}`)
        return last
      }).finally(() => { inflight = undefined })
      return await inflight
    }
  }
}

/** The default provider: CoinGecko, cached. */
export function coingeckoRateProvider (log?: (msg: string) => void): RateProvider {
  return cachedRateProvider({ fetchQuote: coingeckoQuote(), log })
}

/** A fixed quote (tests, demos). `at` defaults to "now" on every call, so it never goes stale. */
export function fixedRateProvider (rate: number, opts: { source?: string, at?: number, now?: () => number } = {}): RateProvider {
  return { current: async () => ({ rate, at: opts.at ?? (opts.now ?? Date.now)(), source: opts.source ?? 'fixed' }) }
}
