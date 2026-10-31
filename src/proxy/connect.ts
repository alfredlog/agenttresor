/**
 * Zero-config agent onboarding: the admin gives the agent a one-time
 * connection code ("AT-XXXX-XXXX", Crockford base32, 40 bits); the agent
 * exchanges it once, within 10 minutes, for its API key and settings.
 * Codes are stored as sha256 only; the exchange is rate-limited per IP.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const CONNECT_CODE_TTL_MS = 10 * 60_000

/** Crockford base32: no I, L, O, U, so codes read back without confusion. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateConnectCode (): string {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  const chars = Array.from(randomBytes(8), b => CROCKFORD[b & 31]).join('')
  return `AT-${chars.slice(0, 4)}-${chars.slice(4)}`
}

/**
 * The canonical form of a code as typed or pasted: case, spaces and hyphens do
 * not matter, I/L read as 1 and O as 0. Undefined if it cannot be a code.
 */
export function normalizeConnectCode (input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > 64) return undefined
  let s = input.toUpperCase().replace(/[\s-]/g, '')
  if (s.startsWith('AT')) s = s.slice(2)
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0')
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s)) return undefined
  return `AT-${s.slice(0, 4)}-${s.slice(4)}`
}

export function hashConnectCode (code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/**
 * The candidate whose hash equals `hash`. Every candidate is compared, with a
 * constant-time comparison and no early exit, so the work done does not depend
 * on whether or where a code matches.
 */
export function findConnectCode<T extends { codeHash: string }> (
  candidates: T[],
  hash: string,
  equal: (a: Buffer, b: Buffer) => boolean = timingSafeEqual
): T | undefined {
  const wanted = Buffer.from(hash, 'hex')
  let found: T | undefined
  for (const c of candidates) {
    const same = equal(Buffer.from(c.codeHash, 'hex'), wanted)
    if (same && found === undefined) found = c
  }
  return found
}

/** Fixed-window rate limit per key (here: client IP). */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number, count: number }>()

  constructor (private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one attempt; false once `key` made more than `max` attempts in the window. */
  hit (key: string): boolean {
    const now = this.now()
    const w = this.hits.get(key)
    if (w === undefined || now - w.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 })
      if (this.hits.size > 10_000) this.prune(now)
      return true
    }
    w.count++
    return w.count <= this.max
  }

  private prune (now: number): void {
    for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k)
  }
}

export interface Merchant {
  name: string
  url: string
  catalogUrl: string
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/** The merchants an agent may pay, from its allowed hosts (https, except on the local machine). */
export function merchantsFor (allowedHosts: string[]): Merchant[] {
  return allowedHosts.map(host => {
    const url = `${LOCAL_HOST.test(host) ? 'http' : 'https'}://${host}`
    return { name: host, url, catalogUrl: `${url}/api/catalog` }
  })
}
