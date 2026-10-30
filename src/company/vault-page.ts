/**
 * Browser script of public/vault.html: the company funds and reclaims agent
 * vaults, and approves payments above the threshold by funding them, all from
 * BSV Desktop (WalletClient('auto')). Bundled by `npm run build:web`.
 *   vault.html?approve=R-…  opens the approval of that request.
 */
import { WalletClient } from '../shared/bsv.js'
import { approveAndFund, fundVault, getApproval, reclaimRequestVault, reclaimVault } from './vault-client.js'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The admin token lives in sessionStorage only, so it is gone when the tab closes.
const session = {
  get: (k: string): string => { try { return sessionStorage.getItem(k) ?? '' } catch { return '' } },
  set: (k: string, v: string): void => { try { sessionStorage.setItem(k, v) } catch {} }
}

let explorer = 'https://whatsonchain.com'
const txLink = (txid: string): string => `<a href="${explorer}/tx/${esc(txid)}" target="_blank" rel="noopener">${esc(txid.slice(0, 16))}…</a>`

function settings (): { proxyUrl: string, adminToken: string, agentId: string } {
  const proxyUrl = $<HTMLInputElement>('proxy').value.trim().replace(/\/$/, '')
  const adminToken = $<HTMLInputElement>('token').value.trim()
  session.set('proxyUrl', proxyUrl)
  session.set('adminToken', adminToken)
  return { proxyUrl, adminToken, agentId: $<HTMLInputElement>('agent').value.trim() }
}

function log (html: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
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
    const body = await res.json() as { error?: string, network: string, vaults: Array<{ agentId: string, agentName: string, status: string, satoshis: number, outpoint: string | null }> }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    explorer = body.network === 'test' ? 'https://test.whatsonchain.com' : 'https://whatsonchain.com'
    $('vaults').innerHTML = body.vaults.length === 0
      ? '<tr><td colspan="5" class="muted">No agent has registered a key yet.</td></tr>'
      : body.vaults.map(v => `<tr data-agent="${esc(v.agentId)}">
          <td class="mono">${esc(v.agentId)}</td><td>${esc(v.agentName)}</td><td>${esc(v.status.replace('_', ' '))}</td>
          <td class="num">${esc(v.satoshis)}</td><td class="mono">${v.outpoint === null ? '' : txLink(v.outpoint.split('.')[0])}</td></tr>`).join('')
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
      ? '<tr><td colspan="7" class="muted">No payment approved yet.</td></tr>'
      : body.requestVaults.map(v => `<tr>
          <td class="mono">${esc(v.requestId)}</td><td>${esc(v.agentName)}</td><td>${esc(v.purpose)}</td>
          <td class="num">${esc(v.satoshis)}</td><td>${esc(v.status)} · <a href="${esc(v.explorerUrl)}" target="_blank" rel="noopener">tx</a></td>
          <td>${esc(v.requestStatus.replace(/_/g, ' '))}</td>
          <td>${v.reclaimable ? `<button data-reclaim="${esc(v.requestId)}">Reclaim</button>` : ''}</td></tr>`).join('')
  } catch (err) {
    log(esc((err as Error).message), 'error')
  }
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
      <dt>Price</dt><dd>${esc(a.priceSats)} sats</dd>
      <dt>Network fee</dt><dd>${esc(a.feeSats)} sats</dd>
      <dt>You fund</dt><dd class="total">${esc(a.totalSats)} sats</dd></dl>`
    $('approve').hidden = false
  } catch (err) {
    $('approval-details').className = 'muted'
    $('approval-details').textContent = (err as Error).message
    $('approve').hidden = true
  }
}

async function refreshAll (): Promise<void> {
  await Promise.all([refreshVaults(), refreshRequestVaults()])
}

async function run (button: HTMLButtonElement, task: () => Promise<void>): Promise<void> {
  button.disabled = true
  try { await task() } catch (err) { log(esc((err as Error).message), 'error') } finally { button.disabled = false }
  await refreshAll()
}

const wallet = new WalletClient('auto')

$<HTMLButtonElement>('fund').addEventListener('click', ev => {
  void run(ev.currentTarget as HTMLButtonElement, async () => {
    const { proxyUrl, adminToken, agentId } = settings()
    const sats = Number($<HTMLInputElement>('amount').value)
    log(`Funding ${esc(agentId)} with ${esc(sats)} sats: approve in BSV Desktop…`)
    const r = await fundVault(wallet, proxyUrl, adminToken, agentId, sats)
    log(`Vault of ${esc(agentId)} funded with ${esc(r.satoshis)} sats: ${txLink(r.txid)}`, 'ok')
  })
})

$<HTMLButtonElement>('reclaim').addEventListener('click', ev => {
  void run(ev.currentTarget as HTMLButtonElement, async () => {
    const { proxyUrl, adminToken, agentId } = settings()
    if (!confirm(`Take the whole vault of ${agentId} back to your wallet?`)) return
    log(`Reclaiming the vault of ${esc(agentId)}: approve in BSV Desktop…`)
    const r = await reclaimVault(wallet, proxyUrl, adminToken, agentId)
    log(`Reclaimed ${esc(r.satoshis)} sats (minus the fee) from ${esc(agentId)}: ${txLink(r.txid)}`, 'ok')
  })
})

$<HTMLButtonElement>('approve').addEventListener('click', ev => {
  void run(ev.currentTarget as HTMLButtonElement, async () => {
    const { proxyUrl, adminToken } = settings()
    log(`Approving ${esc(approveId)}: approve the funding in BSV Desktop…`)
    const r = await approveAndFund(wallet, proxyUrl, adminToken, approveId!)
    log(`Payment ${esc(approveId)} approved and funded with ${esc(r.satoshis)} sats: ${txLink(r.txid)}`, 'ok')
    $('approve').hidden = true
    $('approval-details').insertAdjacentHTML('beforeend', `<p>Approved. The agent can now execute it: ${txLink(r.txid)}</p>`)
  })
})

$('request-vaults').addEventListener('click', ev => {
  const button = (ev.target as HTMLElement).closest('button[data-reclaim]') as HTMLButtonElement | null
  if (button === null) return
  const requestId = button.dataset.reclaim!
  void run(button, async () => {
    const { proxyUrl, adminToken } = settings()
    if (!confirm(`Take the funds approved for ${requestId} back to your wallet?`)) return
    log(`Reclaiming the approval of ${esc(requestId)}: approve in BSV Desktop…`)
    const r = await reclaimRequestVault(wallet, proxyUrl, adminToken, requestId)
    log(`Reclaimed ${esc(r.satoshis)} sats (minus the fee) from ${esc(requestId)}: ${txLink(r.txid)}`, 'ok')
  })
})

$('vaults').addEventListener('click', ev => {
  const row = (ev.target as HTMLElement).closest('tr[data-agent]')
  if (row !== null) $<HTMLInputElement>('agent').value = row.getAttribute('data-agent') ?? ''
})
$<HTMLButtonElement>('refresh').addEventListener('click', () => { void refreshAll() })
$<HTMLInputElement>('token').addEventListener('change', () => { void refreshAll(); void loadApproval() })

$<HTMLInputElement>('proxy').value = session.get('proxyUrl') !== '' ? session.get('proxyUrl') : location.origin
$<HTMLInputElement>('token').value = session.get('adminToken')
void refreshAll()
void loadApproval()
