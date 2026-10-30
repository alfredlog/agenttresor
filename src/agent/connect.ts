/**
 * `npm run connect <code> [--proxy https://…]`: exchanges a one-time
 * connection code for the agent's settings, saves them (agent-config.json,
 * mode 0600), creates or loads the agent's own signing key and registers its
 * public key with the proxy. The API key is never printed.
 */
import { fingerprint } from '../shared/fingerprint.js'
import type { Merchant } from '../proxy/connect.js'
import { writeAgentConfig } from './config.js'
import { loadOrCreateAgentKey, registerAgentKey } from './keys.js'
import { ProxyClient } from './proxy-client.js'

export interface ConnectTarget {
  code: string
  proxyUrl: string
}

export const CONNECT_USAGE = 'usage: npm run connect <code> -- --proxy https://your-proxy   or   npm run connect "https://your-proxy/connect#AT-XXXX-XXXX"'

/**
 * Reads the code and the proxy URL from the command line, in this order:
 * an explicit --proxy, the URL of a connection link (https://<proxy>/connect#AT-…),
 * npm_config_proxy (what npm makes of `npm run connect <code> --proxy URL`
 * without `--`), then PROXY_URL.
 */
export function parseConnectArgs (argv: string[], env: NodeJS.ProcessEnv): ConnectTarget {
  let code: string | undefined
  let proxy: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--proxy') proxy = argv[++i]
    else if (a.startsWith('--proxy=')) proxy = a.slice('--proxy='.length)
    else if (/^https?:\/\//i.test(a)) {
      const url = new URL(a)
      code = decodeURIComponent(url.hash.slice(1))
      proxy ??= url.origin
    } else code = a
  }
  if (code === undefined || code === '') throw new Error(`no connection code given\n${CONNECT_USAGE}`)
  proxy ??= env.npm_config_proxy ?? env.PROXY_URL
  if (proxy === undefined || !/^https?:\/\//i.test(proxy)) throw new Error(`no proxy URL given\n${CONNECT_USAGE}`)
  return { code, proxyUrl: proxy.replace(/\/+$/, '') }
}

export interface ConnectResult {
  agentId: string
  proxyUrl: string
  configPath: string
  fingerprint: string
  registration: 'registered' | 'already_open'
  merchants: Merchant[]
}

export async function connectAgent (target: ConnectTarget, dataDir: string, fetchFn: typeof fetch = fetch): Promise<ConnectResult> {
  let res: Response
  try {
    res = await fetchFn(`${target.proxyUrl}/v1/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: target.code }),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    throw new Error(`cannot reach the proxy at ${target.proxyUrl}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const body = await res.json().catch(() => ({})) as { agentId?: string, apiKey?: string, merchants?: Merchant[], error?: string }
  if (res.status === 429) throw new Error('too many attempts from this address; wait a few minutes and try again')
  if (!res.ok || typeof body.apiKey !== 'string' || typeof body.agentId !== 'string') {
    throw new Error(`the proxy at ${target.proxyUrl} refused the code (${res.status}): ${body.error ?? 'no details'}. Ask your admin for a new code.`)
  }

  // Saved before anything else: the code is used up now, and the key it returned must not be lost.
  // The proxy URL is the one that just answered, not one taken from the answer.
  const configPath = await writeAgentConfig(dataDir, {
    proxyUrl: target.proxyUrl,
    agentId: body.agentId,
    apiKey: body.apiKey,
    merchants: body.merchants ?? [],
    connectedAt: new Date().toISOString()
  })
  const key = await loadOrCreateAgentKey(dataDir)
  const registration = await registerAgentKey(new ProxyClient({ proxyUrl: target.proxyUrl, apiKey: body.apiKey, fetch: fetchFn }), key.publicKey)
  return { agentId: body.agentId, proxyUrl: target.proxyUrl, configPath, fingerprint: fingerprint(key.publicKey), registration, merchants: body.merchants ?? [] }
}
