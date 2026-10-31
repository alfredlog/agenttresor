/**
 * Who may use an agent through the service.
 *
 *  - Bound to loopback (the default): a local client needs no token, but a
 *    request carrying an Origin header (a web page) is refused, and the SDK's
 *    Host check stops DNS rebinding.
 *  - A request that came through a tunnel (X-Forwarded-For, Cf-Connecting-Ip
 *    or Forwarded present) or from any non-loopback client is accepted only
 *    with the agent's tunnel secret: in the path (/agents/<id>/s/<secret>/…)
 *    or as `Authorization: Bearer <secret>`.
 *  - Bound to another interface (MCP_HOST): MCP_TOKEN or the agent's secret is
 *    required on every request.
 * Secrets and tokens are compared as sha256 digests with timingSafeEqual.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

export type AccessDecision =
  | { ok: true, via: 'local' | 'secret' | 'token' }
  | { ok: false, status: 401 | 403, error: string }

export interface AccessInput {
  /** The service listens on a loopback address only. */
  loopbackBind: boolean
  /** The request carries proxy/tunnel forwarding headers. */
  forwarded: boolean
  /** The TCP peer is a loopback address. */
  loopbackClient: boolean
  origin?: string
  /** The secret from /agents/<id>/s/<secret>/…, if the request used that path. */
  pathSecret?: string
  bearer?: string
  /** The agent's tunnel secret, if one was ever generated. */
  agentSecret?: string
  /** MCP_TOKEN, if set. */
  token?: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host)
export const isLoopbackAddress = (address: string | undefined): boolean => address !== undefined && LOOPBACK_ADDRESSES.has(address)

export function isForwarded (req: Request): boolean {
  return req.get('x-forwarded-for') !== undefined || req.get('cf-connecting-ip') !== undefined || req.get('forwarded') !== undefined
}

export function bearerOf (req: Request): string | undefined {
  return /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')?.[1]
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
// Compared against when there is nothing to compare with, so a missing secret takes as long as a wrong one.
const NOTHING = randomBytes(32).toString('base64url')

/** Constant-time comparison of two strings of any length; false if either is missing. */
export function sameSecret (candidate: string | undefined, expected: string | undefined): boolean {
  const equal = timingSafeEqual(digest(candidate ?? ''), digest(expected ?? NOTHING))
  return equal && candidate !== undefined && expected !== undefined && candidate !== ''
}

export function decideAccess (a: AccessInput): AccessDecision {
  const denied = (error: string): AccessDecision => ({ ok: false, status: 401, error })
  // A secret in the path must be right, wherever the request comes from.
  if (a.pathSecret !== undefined) {
    return sameSecret(a.pathSecret, a.agentSecret) ? { ok: true, via: 'secret' } : denied('invalid or revoked agent link')
  }
  const bearerIsSecret = sameSecret(a.bearer, a.agentSecret)
  const bearerIsToken = a.token !== undefined && sameSecret(a.bearer, a.token)
  if (bearerIsSecret) return { ok: true, via: 'secret' }

  if (a.forwarded || !a.loopbackClient) {
    // Through a tunnel only the agent's secret counts; MCP_TOKEN is for direct clients of a non-loopback bind.
    if (bearerIsToken && !a.forwarded && !a.loopbackBind) return { ok: true, via: 'token' }
    return denied('this agent is only reachable from outside with its secret link')
  }
  if (!a.loopbackBind) return bearerIsToken ? { ok: true, via: 'token' } : denied('missing or invalid MCP token')
  if (a.origin !== undefined) return { ok: false, status: 403, error: 'requests from web pages (Origin header) are refused' }
  return { ok: true, via: 'local' }
}

export type PanelAccessDecision = { ok: true } | { ok: false, status: 403 | 404 | 421, error: string }

export interface PanelAccessInput {
  /** The request carries proxy/tunnel forwarding headers. */
  forwarded: boolean
  /** The TCP peer is a loopback address. */
  loopbackClient: boolean
  /** The port the request arrived on. */
  port: number
  host?: string
  origin?: string
  /** An API call (true) or the page itself (false). */
  api: boolean
  /** The CSRF token the request carries (X-Panel-Token). */
  csrf?: string
  /** The service's token for this start. */
  expectedCsrf: string
}

/**
 * Who may use the local agent panel (/ and /panel/api/…): only this machine.
 * Never through a tunnel or from another host (404, as if there were no panel);
 * the Host must be 127.0.0.1:<port> (DNS rebinding); a request with an Origin
 * must come from the panel itself, http://127.0.0.1:<port>; and every API call
 * must carry the per-start CSRF token embedded in the page.
 */
export function decidePanelAccess (a: PanelAccessInput): PanelAccessDecision {
  if (a.forwarded || !a.loopbackClient) return { ok: false, status: 404, error: 'not found' }
  const self = `127.0.0.1:${a.port}`
  if (a.host !== self) return { ok: false, status: 421, error: `open the panel at http://${self}/` }
  if (a.origin !== undefined && a.origin !== `http://${self}`) return { ok: false, status: 403, error: 'requests from other web pages are refused' }
  if (a.api && !sameSecret(a.csrf, a.expectedCsrf)) return { ok: false, status: 403, error: 'missing or invalid panel token: reload the panel' }
  return { ok: true }
}
