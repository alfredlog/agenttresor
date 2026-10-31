/**
 * Browser script of public/vault.html: the company funds and reclaims agent
 * vaults, and approves payments above the threshold by funding them, all from
 * BSV Desktop (WalletClient('auto')). Bundled by `npm run build:web`.
 *   vault.html?approve=R-…  opens the approval of that request.
 */
import { WalletClient } from '../shared/bsv.js'
import { fingerprint } from '../shared/fingerprint.js'
import { approveAndFund, confirmedFingerprint, fundVault, getApproval, getVaultParams, reclaimRequestVault, reclaimVault } from './vault-client.js'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The admin token lives in sessionStorage only, so it is gone when the tab closes.
const session = {
  get: (k: string): string => { try { return sessionStorage.getItem(k) ?? '' } catch { return '' } },
  set: (k: string, v: string): void => { try { sessionStorage.setItem(k, v) } catch {} }
}

let explorer = 'https://whatsonchain.com'
/** 413d699d…a9db40 */
const shortTx = (txid: string): string => txid.length > 16 ? `${txid.slice(0, 8)}…${txid.slice(-6)}` : txid
const txLink = (txid: string): string => `<a class="mono" href="${explorer}/tx/${esc(txid)}" target="_blank" rel="noopener" title="${esc(txid)}">${esc(shortTx(txid))}</a>`
const sats = (n: unknown): string => Number(n ?? 0).toLocaleString('en-US')
const empty = (cols: number, text: string): string => `<tr><td colspan="${cols}" class="empty">${esc(text)}</td></tr>`
const VAULT_PILL: Record<string, string> = { open: 'green', awaiting_funding: 'amber', closed: '', spent: '', reclaimed: '' }
const pill = (status: string, color = VAULT_PILL[status] ?? ''): string => `<span class="pill ${color}">${esc(status.replace(/_/g, ' '))}</span>`

function settings (): { proxyUrl: string, adminToken: string, agentId: string } {
  const proxyUrl = $<HTMLInputElement>('proxy').value.trim().replace(/\/$/, '')
  const adminToken = $<HTMLInputElement>('token').value.trim()
  session.set('proxyUrl', proxyUrl)
  session.set('adminToken', adminToken)
  return { proxyUrl, adminToken, agentId: $<HTMLInputElement>('agent').value.trim() }
}

/** One timeline entry, newest first (the empty-state line goes away with the first one). */
function log (html: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  $('log').querySelector('li.empty')?.remove()
  const li = document.createElement('li')
  li.className = kind
  li.innerHTML = `<span class="time">${new Date().toLocaleTimeString()}</span> ${html}`
  $('log').prepend(li)
}

async function refreshVaults (): Promise<void> {
  const { proxyUrl, adminToken } = settings()
  if (adminToken === '') return
  try {
    const res = await fetch(`${proxyUrl}/admin/vaults`, { headers: { Authorization: `Bearer ${adminToken}` } })
    const body = await res.json() as { error?: string, network: string, vaults: Array<{ agentId: string, agentName: string, status: string, satoshis: number, outpoint: string | null, covenant: Covenant | null, policy?: Policy | null }> }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    explorer = body.network === 'test' ? 'https://test.whatsonchain.com' : 'https://whatsonchain.com'
    $('vaults').innerHTML = body.vaults.length === 0
      ? empty(5, 'No agent has registered a key yet: create one on the dashboard and run its setup command.')
      : body.vaults.map(v => `<tr data-agent="${esc(v.agentId)}" tabindex="0" title="Use this agent in step 1">
          <td class="mono">${esc(v.agentId)}</td><td>${esc(v.agentName)}</td><td>${pill(v.status)}${v.covenant === null ? (v.status === 'open' ? ' <span class="badge">v1</span>' : '') : `<span class="sub"><span class="badge amber" title="${esc(covenantLabel(v.covenant, v.policy))}">${esc(covenantBadge(v.covenant, v.policy))}</span></span>`}</td>
          <td class="num"><span class="vault-sats">${esc(sats(v.satoshis))}</span></td><td>${v.outpoint === null ? '<span class="muted">—</span>' : txLink(v.outpoint.split('.')[0])}</td></tr>`).join('')
  } catch (err) {
    log(esc((err as Error).message), 'error')
  }
}

interface RequestVaultRow {
  requestId: string
  agentName: string
  purpose: string
  satoshis: number
  status: string
  requestStatus: string
  reclaimable: boolean
  explorerUrl: string
}

async function refreshRequestVaults (): Promise<void> {
  const { proxyUrl, adminToken } = settings()
  if (adminToken === '') return
  try {
    const res = await fetch(`${proxyUrl}/admin/request-vaults`, { headers: { Authorization: `Bearer ${adminToken}` } })
    const body = await res.json() as { error?: string, requestVaults: RequestVaultRow[] }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    $('request-vaults').innerHTML = body.requestVaults.length === 0
      ? empty(7, 'No payment approved yet. Approving a payment above the threshold funds one here.')
      : body.requestVaults.map(v => `<tr>
          <td class="mono">${esc(v.requestId)}</td><td>${esc(v.agentName)}</td><td>${esc(v.purpose)}</td>
          <td class="num"><span class="vault-sats">${esc(sats(v.satoshis))}</span></td><td>${pill(v.status, v.status === 'open' ? 'amber' : '')} <a href="${esc(v.explorerUrl)}" target="_blank" rel="noopener">tx</a></td>
          <td>${pill(v.requestStatus, ({ paid: 'green', approved: 'blue', denied: 'red', failed: 'red' } as Record<string, string>)[v.requestStatus] ?? '')}</td>
          <td>${v.reclaimable ? `<button class="small" data-reclaim="${esc(v.requestId)}">Reclaim</button>` : ''}</td></tr>`).join('')
  } catch (err) {
    log(esc((err as Error).message), 'error')
  }
}

// ── Agent key fingerprint: computed HERE from agentPub, never taken from the proxy ──
// Funding stays disabled until the human ticks "I checked this fingerprint on the agent's machine".

let fundShown: string | null = null
let approveShown: string | null = null

function updateButtons (): void {
  const confirmed = confirmedFingerprint(fundShown, $<HTMLInputElement>('fund-confirm').checked) !== null
  $<HTMLButtonElement>('fund').disabled = !confirmed
  $<HTMLButtonElement>('approve').disabled = confirmedFingerprint(approveShown, $<HTMLInputElement>('approve-confirm').checked) === null
  // The three steps: done, current or still ahead (presentation only; the buttons above decide).
  const chosen = fundShown !== null
  const state = (id: string, complete: boolean, current: boolean): void => {
    $(id).classList.toggle('complete', complete)
    $(id).classList.toggle('current', !complete && current)
  }
  state('step-agent', chosen, true)
  state('step-fingerprint', confirmed, chosen)
  state('step-fund', false, confirmed)
}

interface Covenant { maxSats: number, maxFeeSats: number }
/** EUR rules: the exact euro limit, enforced by the policy; the covenant holds the on-chain ceiling. */
interface Policy { currency: 'EUR', maxPerPaymentCents: number }

/** How a v2 vault is described on the page and the dashboard. */
const covenantLabel = (c: Covenant, policy?: Policy | null): string => policy == null
  ? `v2 covenant: max ${c.maxSats} sats per payment, fee at most ${c.maxFeeSats} sats, change locked to the vault`
  : `v2 covenant: max ${(policy.maxPerPaymentCents / 100).toFixed(2)} € per payment, on-chain ceiling ${c.maxSats} sats, fee at most ${c.maxFeeSats} sats, change locked to the vault`

/** The short form, for the v2 badge in the vaults list (the full label is its tooltip). */
const covenantBadge = (c: Covenant, policy?: Policy | null): string => policy == null
  ? `v2 · ≤ ${sats(c.maxSats)} sats · fee ≤ ${sats(c.maxFeeSats)}`
  : `v2 · max ${(policy.maxPerPaymentCents / 100).toFixed(2)} € · on-chain ceiling ${sats(c.maxSats)} sats`

async function loadFundFingerprint (): Promise<void> {
  const { proxyUrl, adminToken, agentId } = settings()
  fundShown = null
  $<HTMLInputElement>('fund-confirm').checked = false
  $<HTMLInputElement>('fund-confirm').disabled = true
  updateButtons()
  if (adminToken === '' || agentId === '') return
  try {
    const params = await getVaultParams(proxyUrl, adminToken, agentId)
    if (params.agentId !== agentId || $<HTMLInputElement>('agent').value.trim() !== agentId) return // answer for an older input
    fundShown = fingerprint(params.agentPub)
    $('fund-fp-text').innerHTML = `<span class="hint">Agent key fingerprint of <span class="mono">${esc(agentId)}</span>, computed here from its public key</span>` +
      `<span class="fp-big">${esc(fundShown)}</span>` +
      (params.covenant == null ? '' : `<span class="hint">This vault will be ${esc(covenantLabel(params.covenant, params.policy))}; you can always reclaim it alone.</span>`)
    $<HTMLInputElement>('fund-confirm').disabled = false
  } catch (err) {
    $('fund-fp-text').textContent = `${agentId}: ${(err as Error).message}`
  }
  updateButtons()
}

const approveId = new URLSearchParams(location.search).get('approve')

async function loadApproval (): Promise<void> {
  if (approveId === null) return
  $('approval-section').hidden = false
  const { proxyUrl, adminToken } = settings()
  if (adminToken === '') return
  try {
    const a = await getApproval(proxyUrl, adminToken, approveId)
    $('approval-details').className = ''
    $('approval-details').innerHTML = `<dl>
      <dt>Request</dt><dd class="mono">${esc(a.requestId)}</dd>
      <dt>Agent</dt><dd>${esc(a.agentName)} <span class="muted mono">${esc(a.agentId)}</span></dd>
      <dt>Purpose</dt><dd>${esc(a.purpose)}</dd>
      <dt>Merchant</dt><dd class="mono">${esc(a.method)} ${esc(a.url)}</dd>
      <dt>Price</dt><dd class="mono">${esc(sats(a.priceSats))} sats</dd>
      <dt>Network fee</dt><dd class="mono">${esc(sats(a.feeSats))} sats</dd>
      <dt>You fund</dt><dd class="total">${esc(sats(a.totalSats))} sats</dd></dl>`
    approveShown = fingerprint(a.agentPub)
    $('approve-fp').textContent = approveShown
    $<HTMLInputElement>('approve-confirm').checked = false
    $('approve-fp-box').hidden = false
    $('approve').hidden = false
  } catch (err) {
    approveShown = null
    $('approval-details').className = 'muted'
    $('approval-details').textContent = (err as Error).message
    $('approve-fp-box').hidden = true
    $('approve').hidden = true
  }
  updateButtons()
}

async function refreshAll (): Promise<void> {
  await Promise.all([refreshVaults(), refreshRequestVaults()])
}

/** Runs a wallet action: a spinner while it runs, a check for 2 s when it succeeded. `false` from the task: cancelled. */
async function run (button: HTMLButtonElement, task: () => Promise<void | false>): Promise<void> {
  button.disabled = true
  button.classList.remove('done')
  button.classList.add('loading')
  let succeeded = false
  try { succeeded = await task() !== false } catch (err) { log(esc((err as Error).message), 'error') } finally {
    button.disabled = false
    button.classList.remove('loading')
  }
  if (succeeded) {
    button.classList.add('done')
    setTimeout(() => { button.classList.remove('done') }, 2_000)
  }
  updateButtons()
  await refreshAll()
}

const wallet = new WalletClient('auto')

$<HTMLButtonElement>('fund').addEventListener('click', ev => {
  void run(ev.currentTarget as HTMLButtonElement, async () => {
    const { proxyUrl, adminToken, agentId } = settings()
    const sats = Number($<HTMLInputElement>('amount').value)
    log(`Funding ${esc(agentId)} with ${esc(sats)} sats: approve in BSV Desktop…`)
    // fundVault recomputes the fingerprint from the key it is about to fund and refuses any other.
    const r = await fundVault(wallet, proxyUrl, adminToken, agentId, sats, confirmedFingerprint(fundShown, $<HTMLInputElement>('fund-confirm').checked))
    log(`Vault of ${esc(agentId)} funded with ${esc(r.satoshis)} sats: ${txLink(r.txid)}`, 'ok')
  })
})

$<HTMLButtonElement>('reclaim').addEventListener('click', ev => {
  void run(ev.currentTarget as HTMLButtonElement, async () => {
    const { proxyUrl, adminToken, agentId } = settings()
    if (!confirm(`Take the whole vault of ${agentId} back to your wallet?`)) return false
    log(`Reclaiming the vault of ${esc(agentId)}: approve in BSV Desktop…`)
    const r = await reclaimVault(wallet, proxyUrl, adminToken, agentId)
    log(`Reclaimed ${esc(r.satoshis)} sats (minus the fee) from ${esc(agentId)}: ${txLink(r.txid)}`, 'ok')
  })
})

$<HTMLButtonElement>('approve').addEventListener('click', ev => {
  void run(ev.currentTarget as HTMLButtonElement, async () => {
    const { proxyUrl, adminToken } = settings()
    log(`Approving ${esc(approveId)}: approve the funding in BSV Desktop…`)
    const r = await approveAndFund(wallet, proxyUrl, adminToken, approveId!, confirmedFingerprint(approveShown, $<HTMLInputElement>('approve-confirm').checked))
    log(`Payment ${esc(approveId)} approved and funded with ${esc(r.satoshis)} sats: ${txLink(r.txid)}`, 'ok')
    $('approve').hidden = true
    $('approve-fp-box').hidden = true
    $('approval-details').insertAdjacentHTML('beforeend', `<p>Approved. The agent can now execute it: ${txLink(r.txid)}</p>`)
  })
})

$('request-vaults').addEventListener('click', ev => {
  const button = (ev.target as HTMLElement).closest('button[data-reclaim]') as HTMLButtonElement | null
  if (button === null) return
  const requestId = button.dataset.reclaim!
  void run(button, async () => {
    const { proxyUrl, adminToken } = settings()
    if (!confirm(`Take the funds approved for ${requestId} back to your wallet?`)) return false
    log(`Reclaiming the approval of ${esc(requestId)}: approve in BSV Desktop…`)
    const r = await reclaimRequestVault(wallet, proxyUrl, adminToken, requestId)
    log(`Reclaimed ${esc(r.satoshis)} sats (minus the fee) from ${esc(requestId)}: ${txLink(r.txid)}`, 'ok')
  })
})

$('vaults').addEventListener('click', ev => {
  const row = (ev.target as HTMLElement).closest('tr[data-agent]')
  if (row === null) return
  $<HTMLInputElement>('agent').value = row.getAttribute('data-agent') ?? ''
  void loadFundFingerprint()
})
// Rows are focusable: Enter picks the agent like a click.
$('vaults').addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('tr[data-agent]')) (ev.target as HTMLElement).click()
})
$<HTMLInputElement>('agent').addEventListener('input', () => {
  // A new agent ID invalidates the fingerprint shown and its confirmation at once.
  fundShown = null
  $<HTMLInputElement>('fund-confirm').checked = false
  $<HTMLInputElement>('fund-confirm').disabled = true
  $('fund-fp-text').textContent = 'Loading the agent key fingerprint…'
  updateButtons()
})
$<HTMLInputElement>('agent').addEventListener('change', () => { void loadFundFingerprint() })
$<HTMLInputElement>('fund-confirm').addEventListener('change', updateButtons)
$<HTMLInputElement>('approve-confirm').addEventListener('change', updateButtons)
$<HTMLButtonElement>('refresh').addEventListener('click', () => { void refreshAll() })
$<HTMLInputElement>('token').addEventListener('change', () => { void refreshAll(); void loadApproval(); void loadFundFingerprint() })

$<HTMLInputElement>('proxy').value = session.get('proxyUrl') !== '' ? session.get('proxyUrl') : location.origin
$<HTMLInputElement>('token').value = session.get('adminToken')
void refreshAll()
void loadApproval()
