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
    /* ── AgentTresor design system (the same block in index.html, vault.html, connect.html and src/service/panel.ts) ── */
    :root {
      color-scheme: dark;
      --bg: #0E1219; --panel: #171D29; --panel-2: #1F2736; --line: #2C3648;
      --text: #F4F1EA; --text-2: #B9C3D3; --muted: #7C889B;
      --amber: #F2B544; --blue: #6E9BFF; --green: #5FD08A; --red: #FF6B5E;
      --amber-bg: rgba(242, 181, 68, .12); --blue-bg: rgba(110, 155, 255, .12); --green-bg: rgba(95, 208, 138, .12); --red-bg: rgba(255, 107, 94, .12);
      --on-accent: #0E1219;
      --shadow: 0 1px 0 rgba(255, 255, 255, .03) inset, 0 8px 24px rgba(0, 0, 0, .25);
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --radius: 12px;
      /* Older names, still used by some markup. */
      --fg: var(--text); --card: var(--panel); --ok: var(--green); --warn: var(--amber); --bad: var(--red); --accent: var(--blue);
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #F5F3EE; --panel: #FFFFFF; --panel-2: #F0EDE6; --line: #DCD7CC;
        --text: #171C27; --text-2: #465165; --muted: #6E7787;
        --amber: #A86F00; --blue: #2F5FD0; --green: #1C8447; --red: #C3362A;
        --amber-bg: rgba(168, 111, 0, .10); --blue-bg: rgba(47, 95, 208, .09); --green-bg: rgba(28, 132, 71, .10); --red-bg: rgba(195, 54, 42, .09);
        --on-accent: #FFFFFF;
        --shadow: 0 1px 2px rgba(23, 28, 39, .06), 0 6px 18px rgba(23, 28, 39, .05);
      }
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--sans); font-feature-settings: "cv11", "ss01"; -webkit-font-smoothing: antialiased; }
    main { max-width: 1200px; margin: 0 auto; padding: 24px 24px 64px; }
    h1, h2, h3 { margin: 0; letter-spacing: -.01em; }
    h1 { font-size: 22px; font-weight: 700; }
    h2 { font-size: 15px; font-weight: 650; }
    p { margin: 8px 0 0; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, .mono { font-family: var(--mono); font-size: 12.5px; }
    .num, .mono, .tabular { font-variant-numeric: tabular-nums; }
    .muted { color: var(--muted); }
    .secondary { color: var(--text-2); }
    .hint { font-size: 13px; color: var(--text-2); }
    [hidden] { display: none !important; }
    :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 6px; }

    /* Top bar */
    .topbar { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
    .topbar-inner { max-width: 1200px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 60px; }
    .wordmark { display: inline-flex; align-items: center; gap: 10px; font-weight: 750; font-size: 17px; letter-spacing: -.02em; color: var(--text); }
    .wordmark:hover { text-decoration: none; }
    .wordmark .mark { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--amber), #E08A2E); display: grid; place-items: center; color: #0E1219; font-size: 14px; font-weight: 800; }
    .topbar nav { display: flex; gap: 4px; margin-left: 8px; }
    .topbar nav a { color: var(--text-2); padding: 6px 10px; border-radius: 8px; font-size: 13px; font-weight: 550; }
    .topbar nav a:hover, .topbar nav a[aria-current="page"] { background: var(--panel-2); color: var(--text); text-decoration: none; }
    .spacer { flex: 1; }
    .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--text-2); font-size: 12.5px; white-space: nowrap; }
    .chip .mono { font-size: 12px; color: var(--text); }

    /* Pills and badges */
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap; background: var(--panel-2); color: var(--text-2); }
    .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .pill.green { background: var(--green-bg); color: var(--green); }
    .pill.red { background: var(--red-bg); color: var(--red); }
    .pill.amber { background: var(--amber-bg); color: var(--amber); }
    .pill.blue { background: var(--blue-bg); color: var(--blue); }
    .pill.plain::before { display: none; }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; font: 600 11px/18px var(--mono); border: 1px solid var(--line); color: var(--text-2); white-space: nowrap; }
    .badge.amber { border-color: color-mix(in srgb, var(--amber) 55%, transparent); color: var(--amber); background: var(--amber-bg); }
    .badge.blue { border-color: color-mix(in srgb, var(--blue) 55%, transparent); color: var(--blue); background: var(--blue-bg); }

    /* Cards and sections */
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow); }
    .section { margin-top: 20px; }
    .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .card-head h2 { display: flex; align-items: center; gap: 8px; }
    .card-head .count { font: 600 12px/20px var(--mono); padding: 0 8px; border-radius: 999px; background: var(--panel-2); color: var(--text-2); min-width: 26px; text-align: center; }
    .card.accent-amber { border-color: color-mix(in srgb, var(--amber) 45%, var(--line)); background: linear-gradient(180deg, var(--amber-bg), transparent 140px), var(--panel); }
    .card.accent-amber .card-head h2 { color: var(--amber); }
    .card.accent-amber .count { background: var(--amber); color: var(--on-accent); }
    .card.accent-blue { border-color: color-mix(in srgb, var(--blue) 40%, var(--line)); }
    .card.accent-green { border-color: color-mix(in srgb, var(--green) 45%, var(--line)); }

    /* Summary tiles: fixed heights, so the 5 s refresh never moves the layout */
    .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }
    .tile { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; min-height: 108px; display: flex; flex-direction: column; gap: 6px; box-shadow: var(--shadow); }
    .tile-label { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; display: flex; align-items: center; gap: 8px; }
    .tile-label::before { content: ""; width: 8px; height: 8px; border-radius: 3px; background: var(--tile, var(--blue)); }
    .tile-value { font: 650 28px/34px var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.02em; color: var(--text); height: 34px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile-sub { font-size: 12.5px; color: var(--text-2); height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile.amber { --tile: var(--amber); } .tile.blue { --tile: var(--blue); } .tile.green { --tile: var(--green); } .tile.red { --tile: var(--red); }
    .tile.alert { border-color: color-mix(in srgb, var(--tile) 55%, var(--line)); }
    .tile.alert .tile-value { color: var(--tile); }

    /* Tables */
    .table { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
    .card .table { border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 11px; font-weight: 650; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; background: var(--panel-2); white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover td { background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
    td.num, th.num { text-align: right; }
    td.num { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.empty, li.empty { text-align: center; color: var(--muted); padding: 28px 16px; font-size: 13.5px; }
    .url { max-width: 300px; word-break: break-all; color: var(--text-2); }
    .sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }

    /* Forms */
    /* Flex, not grid: a label's text and its unit (<span data-unit>) stay on one line, the field wraps below. */
    label { display: flex; flex-wrap: wrap; align-items: baseline; row-gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-2); }
    label > input, label > select { flex: 1 0 100%; }
    label > input[type="checkbox"] { flex: none; }
    input, select { font: inherit; font-size: 14px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--text); min-width: 0; width: 100%; transition: border-color .15s, box-shadow .15s; }
    input::placeholder { color: var(--muted); }
    /* The select follows the theme: no native light box, a drawn chevron, dark options. */
    select { appearance: none; -webkit-appearance: none; padding-right: 34px; cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, var(--text-2) 50%), linear-gradient(135deg, var(--text-2) 50%, transparent 50%); background-position: calc(100% - 17px) 55%, calc(100% - 12px) 55%; background-size: 5px 5px; background-repeat: no-repeat; }
    select option { background: var(--panel-2); color: var(--text); }
    input:focus, select:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-bg); }
    input[type="checkbox"] { width: 18px; height: 18px; padding: 0; accent-color: var(--green); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
    .actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; align-items: center; }
    .check { display: flex; flex-direction: row; gap: 10px; align-items: center; font-size: 13.5px; font-weight: 550; color: var(--text); margin-top: 12px; cursor: pointer; }

    /* Buttons */
    button, a.button, a.approve { font: inherit; font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--text); cursor: pointer; white-space: nowrap; transition: background .15s, border-color .15s, color .15s, opacity .15s; text-decoration: none; }
    button:hover:not(:disabled), a.button:hover, a.approve:hover { border-color: var(--text-2); text-decoration: none; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button.primary { background: var(--blue); border-color: var(--blue); color: var(--on-accent); }
    button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--blue) 85%, white); border-color: transparent; }
    button.money, a.approve, button.approve, button.ok { background: var(--amber); border-color: var(--amber); color: var(--on-accent); }
    button.money:hover:not(:disabled), a.approve:hover, button.approve:hover:not(:disabled), button.ok:hover:not(:disabled) { background: color-mix(in srgb, var(--amber) 85%, white); border-color: transparent; }
    button.deny { background: transparent; border-color: color-mix(in srgb, var(--red) 55%, var(--line)); color: var(--red); }
    button.deny:hover:not(:disabled) { background: var(--red-bg); border-color: var(--red); }
    button.ghost { background: transparent; }
    button.small, a.small { min-height: 30px; padding: 0 10px; font-size: 12.5px; }
    /* Loading and success states (vault page): the label stays, a spinner or a check is added. */
    button.loading { cursor: progress; opacity: .85 !important; }
    button.loading::before { content: ""; width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
    button.done { background: var(--green) !important; border-color: var(--green) !important; color: var(--on-accent) !important; }
    button.done::before { content: "✓"; font-weight: 800; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { button.loading::before { animation-duration: 2.4s; } }

    /* Keys, fingerprints, codes */
    .fp { font-family: var(--mono); font-weight: 650; letter-spacing: .04em; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.mono, .sub.mono, .nowrap { white-space: nowrap; }
    td.url, td.details { white-space: normal; }
    .fp-big { display: block; font: 700 clamp(26px, 6vw, 40px)/1.15 var(--mono); letter-spacing: .06em; color: var(--amber); margin: 10px 0 2px; word-break: break-all; }
    .ok-text { color: var(--green); } .bad-text { color: var(--red); } .warn-text { color: var(--amber); }

    /* Steps (vault page) */
    .steps { display: grid; gap: 14px; counter-reset: step; }
    .step { position: relative; padding-left: 58px; }
    .step::before { counter-increment: step; content: counter(step); position: absolute; left: 20px; top: 20px; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font: 700 13px/1 var(--mono); background: var(--panel-2); color: var(--text-2); border: 1px solid var(--line); }
    .step.current::before { background: var(--blue); color: var(--on-accent); border-color: var(--blue); }
    .step.complete::before { content: "✓"; background: var(--green); color: var(--on-accent); border-color: var(--green); }
    .step h3 { font-size: 15px; font-weight: 650; margin-bottom: 4px; }

    /* Timeline (vault page activity) */
    .timeline { list-style: none; margin: 0; padding: 0 0 0 18px; position: relative; display: grid; gap: 12px; }
    .timeline::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 2px; background: var(--line); border-radius: 2px; }
    .timeline li { position: relative; padding: 10px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; word-break: break-word; }
    .timeline li::before { content: ""; position: absolute; left: -18px; top: 15px; width: 12px; height: 12px; border-radius: 50%; background: var(--panel); border: 2px solid var(--muted); }
    .timeline li.ok::before { border-color: var(--green); background: var(--green); }
    .timeline li.error { border-color: color-mix(in srgb, var(--red) 50%, var(--line)); color: var(--red); }
    .timeline li.error::before { border-color: var(--red); background: var(--red); }
    .timeline li.info::before { border-color: var(--blue); }
    .timeline .time { display: block; font: 12px var(--mono); color: var(--muted); margin-bottom: 2px; }
    .timeline li.empty { background: transparent; border-style: dashed; }
    .timeline li.empty::before { display: none; }

    /* Checklist (local panel) */
    .checklist { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .checklist li { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
    .checklist .icon { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 12px; color: var(--on-accent); background: var(--muted); }
    .checklist li.ok .icon { background: var(--green); }
    .checklist li.bad { border-color: color-mix(in srgb, var(--red) 45%, var(--line)); }
    .checklist li.bad .icon { background: var(--red); }
    .checklist .name { font-weight: 650; }
    .checklist .fix { margin-top: 6px; font-size: 13px; color: var(--text-2); }
    .checklist .fix code { color: var(--amber); }

    @media (max-width: 900px) {
      .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      main { padding: 16px 14px 48px; }
      .topbar-inner { padding: 10px 14px; gap: 8px; }
      .topbar nav { margin-left: 0; order: 3; width: 100%; }
      .card { padding: 16px; }
      .tiles { gap: 10px; }
      .tile { padding: 12px 14px; min-height: 96px; }
      .tile-value { font-size: 22px; line-height: 30px; height: 30px; }
      th, td { padding: 9px 10px; }
      /* Narrow screens: tables keep readable columns and scroll sideways inside their card. */
      .table table { min-width: 720px; }
      /* .stack tables (e.g. pending approvals) turn each row into a small card instead, so their buttons stay in view. */
      .table.stack table { min-width: 0; }
      .table.stack thead { display: none; }
      .table.stack tr { display: grid; gap: 6px; padding: 14px; border-bottom: 1px solid var(--line); }
      .table.stack tbody tr:last-child { border-bottom: 0; }
      .table.stack td { display: block; border: 0; padding: 0; text-align: left; white-space: normal; }
      .table.stack td.empty { padding: 14px 0; text-align: center; }
      .step { padding-left: 50px; }
      .step::before { left: 14px; top: 16px; }
    }
    /* ── end of the design system ── */
    /* ── Local panel (no external fonts: the CSP allows none, so Inter only if it is installed) ── */
    main { max-width: 1080px; }
    .intro p { color: var(--text-2); margin-top: 6px; }
    tr.active-row td { background: var(--blue-bg); }
    tr.active-row td:first-child { box-shadow: inset 3px 0 0 var(--blue); }
    .vault-sats { font: 650 14px var(--mono); color: var(--amber); }
    td.action { text-align: right; white-space: nowrap; }
    #error { margin-top: 16px; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--red) 50%, var(--line)); background: var(--red-bg); color: var(--red); border-radius: 10px; font-weight: 550; }
    #error:empty { display: none; }
    .head-actions { margin-left: auto; }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <span class="wordmark"><span class="mark">A</span>AgentTresor</span>
    <span class="secondary" style="font-weight:600">Local agent panel</span>
    <span class="spacer"></span>
    <span class="chip">this machine only</span>
  </div>
</header>
<main>
  <div class="intro">
    <h1>Agents on this machine</h1>
    <p>The active agent is the one your MCP clients reach at <code id="mcp"></code>. After switching, start a new conversation.</p>
  </div>
  <div id="error"></div>
  <section class="card section">
    <div class="card-head"><h2>Agents</h2></div>
    <div class="table"><table>
      <thead><tr><th>Agent</th><th>Proxy</th><th>Key fingerprint</th><th>Vault</th><th></th></tr></thead>
      <tbody id="agents"><tr><td colspan="5" class="empty">Loading the agent profiles…</td></tr></tbody>
    </table></div>
  </section>
  <section class="card section">
    <div class="card-head"><h2>Doctor</h2><button id="recheck" class="small head-actions">Check again</button></div>
    <ul id="checks" class="checklist"><li class="empty">Checking this machine…</li></ul>
  </section>
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
  const sats = n => Number(n).toLocaleString('en-US')
  async function api (path, init = {}) {
    const res = await fetch(path, { ...init, headers: { 'X-Panel-Token': token } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
    return body
  }
  const pill = (text, color) => el('span', { className: 'pill ' + (color || ''), textContent: text })
  function vaultCell (a) {
    const v = a.vault
    const td = el('td')
    if (!v) { td.append(el('span', { className: 'muted', textContent: 'unknown' })); return td }
    if (v.status === 'none') { td.append(pill('no key registered', 'amber')); return td }
    td.append(el('span', { className: 'vault-sats', textContent: sats(v.satoshis) + ' sats' }), ' ', pill(v.status.replace(/_/g, ' '), v.status === 'open' ? 'green' : 'amber'))
    if (v.version && v.status === 'open') {
      const caps = v.version === 'v2' && v.caps ? ' · ≤ ' + sats(v.caps.maxSats) + ' sats · fee ≤ ' + sats(v.caps.maxFeeSats) : ''
      td.append(el('span', { className: 'sub' }, el('span', { className: 'badge' + (v.version === 'v2' ? ' amber' : ''), textContent: v.version + caps })))
    }
    if (typeof a.remainingTodaySats === 'number') td.append(el('span', { className: 'sub', textContent: sats(a.remainingTodaySats) + ' sats left today' }))
    return td
  }
  async function loadAgents () {
    const { agents } = await api('/panel/api/agents')
    const rows = agents.map(a => {
      const who = el('td', {}, el('div', { className: 'mono', textContent: a.agentId }))
      if (a.name) who.append(el('div', { style: 'font-weight:650', textContent: a.name }))
      if (a.active) who.append(el('span', { className: 'sub' }, pill('ACTIVE', 'blue')))
      const reachable = a.proxy === 'reachable'
      const proxy = el('td', {}, el('div', { className: 'mono secondary', textContent: a.proxyUrl || '-' }),
        el('span', { className: 'sub' }, pill(a.error || a.proxy, reachable ? 'green' : 'red')))
      const action = el('td', { className: 'action' })
      if (!a.active && a.proxyUrl) {
        const b = el('button', { className: 'primary small', textContent: 'Activate' })
        b.addEventListener('click', async () => {
          b.disabled = true
          try { await api('/panel/api/agents/' + encodeURIComponent(a.agentId) + '/activate', { method: 'POST' }); $('error').textContent = '' } catch (err) { $('error').textContent = err.message }
          await refresh()
        })
        action.append(b)
      }
      return el('tr', { className: a.active ? 'active-row' : '' }, who, proxy, el('td', { className: 'fp', textContent: a.fingerprint || 'no key yet' }), vaultCell(a), action)
    })
    $('agents').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'No agent on this machine yet: run npm run setup "<connection link>" with the link from the dashboard.' }))]))
  }
  async function loadChecks () {
    $('checks').replaceChildren(el('li', { className: 'empty', textContent: 'Checking this machine…' }))
    const { checks } = await api('/panel/api/doctor')
    if (checks.length === 0) { $('checks').replaceChildren(el('li', { className: 'empty', textContent: 'No checks are available from this service.' })); return }
    $('checks').replaceChildren(...checks.map(c => {
      const body = el('div', {}, el('div', { className: 'name', textContent: c.name }), el('div', { className: 'secondary', textContent: c.detail }))
      if (c.fixed) body.append(el('div', { className: 'fix', textContent: 'done: ' + c.fixed }))
      if (!c.ok && c.fix) body.append(el('div', { className: 'fix' }, 'fix: ', el('code', { textContent: c.fix })))
      return el('li', { className: c.ok ? 'ok' : 'bad' }, el('span', { className: 'icon', textContent: c.ok ? '✓' : '✗' }), body)
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
