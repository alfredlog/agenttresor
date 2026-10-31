/**
 * The local agent panel, served by the agent service at http://127.0.0.1:<port>/
 * (this machine only, see decidePanelAccess):
 *
 *   GET  /                                   the page, with this start's CSRF token in it
 *   GET  /panel/api/agents                   the profiles: proxy, fingerprint, vault, which one is active
 *   POST /panel/api/agents/:agentId/activate same as `npm run agents use <agentId>`
 *   GET  /panel/api/doctor                   the doctor checks with their fixes
 *
 * Answers are built field by field from what is safe to show: no private key,
 * agt_ key or tunnel secret ever reaches the page.
 */
import { randomBytes } from 'node:crypto'
import express, { type NextFunction, type Request, type Response, type Router } from 'express'
import { listProfiles, readActiveAgent, readProfile, setActiveAgent, type ProfileInfo } from '../agent/profiles.js'
import { ProxyClient } from '../agent/proxy-client.js'
import { decidePanelAccess, isForwarded, isLoopbackAddress } from './access.js'
import type { Check } from './doctor.js'

export const PANEL_TOKEN_HEADER = 'x-panel-token'
const PROXY_TIMEOUT_MS = 5_000

export interface PanelVault {
  status: string
  satoshis: number
  version: 'v1' | 'v2' | null
  /** The v2 covenant's caps. */
  caps?: { maxSats: number, maxFeeSats: number }
}

export interface PanelAgent {
  agentId: string
  name?: string
  proxyUrl?: string
  fingerprint?: string
  active: boolean
  /** reachable, or why the proxy cannot be used. */
  proxy: string
  vault?: PanelVault
  remainingTodaySats?: number
  /** Why the profile cannot be used, if it cannot. */
  error?: string
}

/** Removes anything shaped like an agent API key (even masked) from a message. */
export const scrub = (text: string): string => text.replace(/agt_[0-9a-f]*…?/gi, '[agent key]')

function vaultOf (v: any): PanelVault | undefined {
  if (v === null || typeof v !== 'object' || typeof v.status !== 'string') return undefined
  const version = v.status === 'none' ? null : v.version === 2 ? 'v2' : 'v1'
  const caps = version === 'v2' && v.covenant != null && Number.isFinite(v.covenant.maxSats) && Number.isFinite(v.covenant.maxFeeSats)
    ? { maxSats: Number(v.covenant.maxSats), maxFeeSats: Number(v.covenant.maxFeeSats) }
    : undefined
  return { status: v.status, satoshis: Number(v.satoshis ?? 0), version, ...(caps === undefined ? {} : { caps }) }
}

async function panelAgent (p: ProfileInfo, active: string | undefined, fetchFn: typeof fetch): Promise<PanelAgent> {
  const a: PanelAgent = {
    agentId: p.agentId,
    name: p.config?.name,
    proxyUrl: p.config?.proxyUrl,
    fingerprint: p.fingerprint,
    active: p.agentId === active,
    proxy: 'not connected'
  }
  if (p.config === undefined) { a.error = scrub(p.error ?? 'not connected'); return a }
  try {
    const timed: typeof fetch = async (url, init) => await fetchFn(url, { ...init, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) })
    const res = await new ProxyClient({ proxyUrl: p.config.proxyUrl, apiKey: p.config.apiKey, fetch: timed }).budget()
    if (res.status === 200) {
      a.proxy = 'reachable'
      a.vault = vaultOf(res.body?.vault)
      if (Number.isFinite(res.body?.remainingTodaySats)) a.remainingTodaySats = Number(res.body.remainingTodaySats)
    } else {
      a.proxy = res.status === 401 ? 'the proxy refuses this agent\'s key: ask the company for a new connection link' : `the proxy answered ${res.status}`
    }
  } catch (err) {
    a.proxy = scrub(`unreachable (${err instanceof Error ? err.message : String(err)})`)
  }
  return a
}

/** Every profile on this machine, as the panel shows it. */
export async function panelAgents (dataDir: string, fetchFn: typeof fetch = fetch): Promise<PanelAgent[]> {
  const active = await readActiveAgent(dataDir)
  return await Promise.all((await listProfiles(dataDir)).map(async p => await panelAgent(p, active, fetchFn)))
}

export interface PanelOptions {
  dataDir: string
  /** The doctor checks (undefined: the panel shows none). */
  doctor?: () => Promise<Check[]>
  fetch?: typeof fetch
  log?: (msg: string) => void
}

export function createPanelRouter (opts: PanelOptions): Router {
  // A new token on every start: a page from an earlier start must be reloaded.
  const csrf = randomBytes(32).toString('base64url')
  const log = opts.log ?? (() => {})
  const router = express.Router()

  const guard = (api: boolean) => (req: Request, res: Response, next: NextFunction): void => {
    const port = req.socket.localPort ?? 0
    const loopbackClient = isLoopbackAddress(req.socket.remoteAddress)
    // http://localhost:<port>/ opens the panel at its one address, so the browser's Origin is the expected one.
    if (!api && loopbackClient && !isForwarded(req) && req.get('host') === `localhost:${port}`) { res.redirect(302, `http://127.0.0.1:${port}/`); return }
    const d = decidePanelAccess({
      forwarded: isForwarded(req),
      loopbackClient,
      port,
      host: req.get('host'),
      origin: req.get('origin'),
      api,
      csrf: req.get(PANEL_TOKEN_HEADER),
      expectedCsrf: csrf
    })
    if (!d.ok) { res.status(d.status).json({ error: d.error }); return }
    res.set('Cache-Control', 'no-store')
    next()
  }
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response): void => {
    fn(req, res).catch(err => {
      log(`panel request failed: ${scrub(err instanceof Error ? err.message : String(err))}`)
      if (!res.headersSent) res.status(500).json({ error: 'internal error' })
    })
  }

  router.get('/', guard(false), (_req, res) => {
    const nonce = randomBytes(16).toString('base64')
    res.set({
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    })
    res.type('html').send(panelPage(csrf, nonce))
  })

  router.get('/panel/api/agents', guard(true), wrap(async (_req, res) => {
    res.json({ agents: await panelAgents(opts.dataDir, opts.fetch) })
  }))

  router.post('/panel/api/agents/:agentId/activate', guard(true), wrap(async (req, res) => {
    const agentId = String(req.params.agentId)
    let p: ProfileInfo | undefined
    try {
      p = await readProfile(opts.dataDir, agentId)
    } catch {
      res.status(400).json({ error: 'not a valid agent id' })
      return
    }
    if (p?.config === undefined) { res.status(404).json({ error: `no connected agent ${agentId} on this machine` }); return }
    await setActiveAgent(opts.dataDir, agentId)
    log(`panel: active agent is now ${agentId}`)
    res.json({ active: agentId })
  }))

  router.get('/panel/api/doctor', guard(true), wrap(async (_req, res) => {
    const checks = opts.doctor === undefined ? [] : await opts.doctor()
    res.json({
      checks: checks.map(c => ({
        name: c.name,
        ok: c.ok,
        detail: scrub(c.detail),
        ...(c.fix === undefined ? {} : { fix: scrub(c.fix) }),
        ...(c.fixed === undefined ? {} : { fixed: scrub(c.fixed) })
      }))
    })
  }))

  router.use('/panel', (_req, res) => { res.status(404).json({ error: 'not found' }) })
  return router
}

/** The panel page. `csrf` is this start's token, `nonce` the CSP nonce of its one script. */
export function panelPage (csrf: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="panel-token" content="${csrf}">
<title>AgentTresor Agents</title>
<style>
  :root { --bg: #f7f7f5; --fg: #1d1d1b; --muted: #6b6b66; --line: #deded8; --card: #fff; --ok: #1f7a4d; --warn: #9a6200; --bad: #b3261e; --accent: #2b59c3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --fg: #ecece8; --muted: #9a9a94; --line: #33332f; --card: #1f1f1d; --ok: #5cc28f; --warn: #e0a84a; --bad: #f08a80; --accent: #8fb0ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  .muted { color: var(--muted); }
  .table { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; }
  tr:last-child td { border-bottom: 0; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .fp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  button { font: inherit; padding: 6px 12px; border: 1px solid var(--accent); color: var(--accent); border-radius: 6px; background: var(--card); cursor: pointer; }
  .active { color: var(--ok); font-weight: 700; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  ul.checks { list-style: none; padding: 0; margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  ul.checks li { padding: 8px 12px; border-bottom: 1px solid var(--line); }
  ul.checks li:last-child { border-bottom: 0; }
  .fix { font-size: 12px; margin-top: 2px; }
  #error { color: var(--bad); }
</style>
</head>
<body>
<main>
  <h1>Agents on this machine</h1>
  <div class="muted">The active agent is the one your MCP clients reach at <code id="mcp"></code>. After switching, start a new conversation.</div>
  <div id="error"></div>
  <h2>Agents</h2>
  <div class="table"><table>
    <thead><tr><th>Agent</th><th>Proxy</th><th>Key fingerprint</th><th>Vault</th><th></th></tr></thead>
    <tbody id="agents"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
  </table></div>
  <h2>Doctor <button id="recheck">Check again</button></h2>
  <ul id="checks" class="checks"><li class="muted">Checking…</li></ul>
</main>
<script nonce="${nonce}">
  const token = document.querySelector('meta[name="panel-token"]').content
  const $ = id => document.getElementById(id)
  $('mcp').textContent = location.origin + '/mcp'
  const el = (tag, props = {}, ...children) => {
    const e = Object.assign(document.createElement(tag), props)
    for (const c of children) e.append(c)
    return e
  }
  async function api (path, init = {}) {
    const res = await fetch(path, { ...init, headers: { 'X-Panel-Token': token } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
    return body
  }
  function vaultText (v) {
    if (!v) return el('span', { className: 'muted', textContent: 'unknown' })
    if (v.status === 'none') return el('span', { className: 'warn', textContent: 'no key registered' })
    const kind = v.version === 'v2' && v.caps ? 'v2, max ' + v.caps.maxSats + ' sats per payment, fee ≤ ' + v.caps.maxFeeSats : (v.version || '')
    return el('span', { className: v.status === 'open' ? 'ok' : 'warn', textContent: v.satoshis + ' sats (' + v.status + ')' + (kind ? ' · ' + kind : '') })
  }
  async function loadAgents () {
    const { agents } = await api('/panel/api/agents')
    const rows = agents.map(a => {
      const who = el('td', {}, el('div', { className: 'mono', textContent: a.agentId }))
      if (a.name) who.append(el('div', { textContent: a.name }))
      if (a.active) who.append(el('div', { className: 'active', textContent: 'ACTIVE' }))
      const proxy = el('td', {}, el('div', { className: 'mono', textContent: a.proxyUrl || '-' }),
        el('div', { className: a.proxy === 'reachable' ? 'ok' : 'bad', textContent: a.error || a.proxy }))
      const action = el('td')
      if (!a.active && a.proxyUrl) {
        const b = el('button', { textContent: 'Activate' })
        b.addEventListener('click', async () => {
          b.disabled = true
          try { await api('/panel/api/agents/' + encodeURIComponent(a.agentId) + '/activate', { method: 'POST' }); $('error').textContent = '' } catch (err) { $('error').textContent = err.message }
          await refresh()
        })
        action.append(b)
      }
      const vault = el('td', {}, vaultText(a.vault))
      if (typeof a.remainingTodaySats === 'number') vault.append(el('div', { className: 'muted', textContent: a.remainingTodaySats + ' sats left today' }))
      return el('tr', {}, who, proxy, el('td', { className: 'fp', textContent: a.fingerprint || 'no key yet' }), vault, action)
    })
    $('agents').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: 'No agent yet: npm run setup "<connection link>"' }))]))
  }
  async function loadChecks () {
    $('checks').replaceChildren(el('li', { className: 'muted', textContent: 'Checking…' }))
    const { checks } = await api('/panel/api/doctor')
    $('checks').replaceChildren(...checks.map(c => {
      const li = el('li', {}, el('span', { className: c.ok ? 'ok' : 'bad', textContent: (c.ok ? '✓ ' : '✗ ') + c.name + ': ' }), c.detail)
      if (c.fixed) li.append(el('div', { className: 'fix muted', textContent: 'done: ' + c.fixed }))
      if (!c.ok && c.fix) li.append(el('div', { className: 'fix' }, 'fix: ', el('code', { textContent: c.fix })))
      return li
    }))
  }
  async function refresh () {
    try { await Promise.all([loadAgents(), loadChecks()]) } catch (err) { $('error').textContent = err.message }
  }
  $('recheck').addEventListener('click', () => { loadChecks().catch(err => { $('error').textContent = err.message }) })
  refresh()
</script>
</body>
</html>
`
}
