/**
 * Company side of the vault, written against BRC-100's WalletInterface: the
 * browser page passes `new WalletClient('auto')` (BSV Desktop), tests pass a
 * wallet-toolbox wallet. The company's key never leaves its wallet.
 *
 *  - fundVault: lock `sats` in this agent's vault script (agent AND policy, or company alone);
 *    a v2 script (OP_PUSH_TX covenant on the agent + policy branch) when the proxy asks for one.
 *    Funding needs the agent key fingerprint a human confirmed on the agent's machine:
 *    it is recomputed here from the key about to be funded, never taken from the proxy.
 *  - approveAndFund: approve one payment above the threshold by funding a request
 *    vault (same script) with exactly its price + fee. Without it the payment is impossible.
 *  - reclaimVault / reclaimRequestVault: take a vault back with the company signature alone.
 */
import { LockingScript, Signature, Transaction, Utils, type WalletInterface, type WalletProtocol } from '../shared/bsv.js'
import { isFingerprint, requireConfirmedFingerprint } from '../shared/fingerprint.js'
import { covenantLockingScript, parseVaultSource } from '../vault/covenant.js'
import { reclaimUnlockingScript, RECLAIM_UNLOCK_LENGTH, vaultLockingScript, vaultSighash } from '../vault/script.js'

/**
 * A wallet call that failed, with the clearest message we have. Over BSV
 * Desktop (HTTPWalletJSON) a failure often reports only its HTTP status; the
 * wallet's own reason is then only in the response body, so `hint` says where
 * to find it.
 */
export class WalletCallError extends Error {
  constructor (readonly call: string, message: string, readonly hint?: string) {
    super(message)
    this.name = 'WalletCallError'
  }
}

/** Turns any error of the wallet call `call` into a WalletCallError. */
export function walletCallError (call: string, err: unknown): WalletCallError {
  if (err instanceof WalletCallError) return err
  const e = (err ?? {}) as { message?: unknown, code?: unknown, name?: unknown }
  const raw = typeof e.message === 'string' && e.message !== '' ? e.message : String(err)
  const code = typeof e.code === 'string' && /^WERR_/.test(e.code)
    ? e.code
    : typeof e.name === 'string' && /^WERR_/.test(e.name) ? e.name : undefined
  const hint = `open DevTools > Network > ${call} > Response for details`
  const status = /failed with HTTP status (\d+)/.exec(raw)?.[1]
  if (status !== undefined) return new WalletCallError(call, `the wallet refused ${call} (HTTP ${status}) without saying why`, hint)
  let message = `the wallet refused ${call}: ${raw}${code !== undefined && !raw.includes(code) ? ` (${code})` : ''}`
  if (/merged Beef failed validation/i.test(raw)) message += '; the vault\'s stored transaction data is older than what the wallet knows: reload the page and try again'
  return new WalletCallError(call, message, code === 'WERR_INTERNAL' ? hint : undefined)
}

async function walletCall<T> (call: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw walletCallError(call, err)
  }
}

export interface ProxyAdmin {
  proxyUrl: string
  adminToken: string
}

/** Admin API call to the proxy (Bearer ADMIN_TOKEN); throws with the proxy's error message. */
export async function proxyCall<T> (admin: ProxyAdmin, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${admin.proxyUrl.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `proxy answered ${res.status}`)
  return json
}

export interface VaultParams {
  agentId: string
  agentPub: string
  policyPub: string
  protocolID: WalletProtocol
  keyID: string
  /** Set when the proxy runs with VAULT_COVENANT=true: fund a v2 vault capped at maxSats per payment and maxFeeSats of fee. */
  covenant?: { maxSats: number, maxFeeSats: number } | null
  /** Under EUR rules: the exact euro limit the policy keeps; the covenant's maxSats is its on-chain ceiling. */
  policy?: { currency: 'EUR', maxPerPaymentCents: number } | null
}

/** The keys of an agent's vault, before funding (the page computes the fingerprint from agentPub). */
export async function getVaultParams (proxyUrl: string, adminToken: string, agentId: string): Promise<VaultParams> {
  return await proxyCall<VaultParams>({ proxyUrl, adminToken }, `/admin/vaults/${encodeURIComponent(agentId)}/params`)
}

/**
 * What the vault page passes to fundVault / approveAndFund: the fingerprint it
 * showed (computed in the browser from agentPub), only if the human ticked
 * "I checked this fingerprint on the agent's machine". Otherwise null, which
 * the funding functions refuse.
 */
export function confirmedFingerprint (shown: string | null, checked: boolean): string | null {
  return checked && isFingerprint(shown) ? shown : null
}

export interface FundResult {
  txid: string
  vout: number
  satoshis: number
}

export async function fundVault (
  wallet: WalletInterface, proxyUrl: string, adminToken: string, agentId: string, sats: number, confirmedFingerprint: string | null
): Promise<FundResult> {
  if (!Number.isSafeInteger(sats) || sats < 1) throw new Error('amount must be a positive number of satoshis')
  const admin = { proxyUrl, adminToken }
  const id = encodeURIComponent(agentId)
  const params = await getVaultParams(proxyUrl, adminToken, agentId)
  requireConfirmedFingerprint(params.agentPub, confirmedFingerprint)
  const { publicKey: companyPub } = await walletCall('getPublicKey', async () => await wallet.getPublicKey({ protocolID: params.protocolID, keyID: params.keyID, counterparty: 'self' }))
  const keys = { agentPub: params.agentPub, policyPub: params.policyPub, companyPub }
  // v2 keeps the company's reclaim branch exactly as v1: the covenant only binds the agent + policy branch.
  const lockingScript = (params.covenant == null ? vaultLockingScript(keys) : covenantLockingScript({ ...keys, ...params.covenant })).toHex()

  const created = await walletCall('createAction', async () => await wallet.createAction({
    description: `Fund AgentTresor vault ${agentId}`.slice(0, 50),
    outputs: [{ lockingScript, satoshis: sats, outputDescription: 'AgentTresor vault' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  }))
  if (created.tx === undefined || created.txid === undefined) throw new Error('the wallet did not create the funding transaction')
  // Find the vault output by its locking script, never by position.
  const vout = Transaction.fromAtomicBEEF(created.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  if (vout === -1) throw new Error('vault output not found in the funding transaction')

  await proxyCall(admin, `/admin/vaults/${id}/funded`, { beef: Utils.toHex(Array.from(created.tx)), vout, companyPub })
  return { txid: created.txid, vout, satoshis: sats }
}

export interface ApprovalInfo {
  requestId: string
  agentId: string
  agentName: string
  purpose: string
  url: string
  method: string
  priceSats: number
  feeSats: number
  totalSats: number
  agentPub: string
  policyPub: string
  protocolID: WalletProtocol
  keyID: string
}

/** What the company is asked to approve (shown before it funds anything). */
export async function getApproval (proxyUrl: string, adminToken: string, requestId: string): Promise<ApprovalInfo> {
  return await proxyCall<ApprovalInfo>({ proxyUrl, adminToken }, `/admin/requests/${encodeURIComponent(requestId)}/approval`)
}

/**
 * Approves a payment above the threshold by funding it: one output of exactly
 * price + fee, locked by the agent's vault script, reserved for this request.
 */
export async function approveAndFund (
  wallet: WalletInterface, proxyUrl: string, adminToken: string, requestId: string, confirmedFingerprint: string | null
): Promise<FundResult> {
  const admin = { proxyUrl, adminToken }
  const id = encodeURIComponent(requestId)
  const a = await getApproval(proxyUrl, adminToken, requestId)
  requireConfirmedFingerprint(a.agentPub, confirmedFingerprint)
  const { publicKey: companyPub } = await walletCall('getPublicKey', async () => await wallet.getPublicKey({ protocolID: a.protocolID, keyID: a.keyID, counterparty: 'self' }))
  const lockingScript = vaultLockingScript({ agentPub: a.agentPub, policyPub: a.policyPub, companyPub }).toHex()

  const created = await walletCall('createAction', async () => await wallet.createAction({
    description: `Approve AgentTresor payment ${requestId}`.slice(0, 50),
    outputs: [{ lockingScript, satoshis: a.totalSats, outputDescription: `Approved payment ${requestId}`.slice(0, 50) }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  }))
  if (created.tx === undefined || created.txid === undefined) throw new Error('the wallet did not create the approval transaction')
  // Find the request vault output by its locking script, never by position.
  const vout = Transaction.fromAtomicBEEF(created.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  if (vout === -1) throw new Error('request vault output not found in the approval transaction')

  await proxyCall(admin, `/admin/requests/${id}/approve`, { beef: Utils.toHex(Array.from(created.tx)), vout, companyPub })
  return { txid: created.txid, vout, satoshis: a.totalSats }
}

export interface ReclaimResult {
  txid: string
  satoshis: number
}

interface ReclaimableUtxo { outpoint: string, satoshis: number, lockingScript: string, beef: string, protocolID: WalletProtocol, keyID: string }

/** Takes an agent's vault back with the company signature alone. */
export async function reclaimVault (wallet: WalletInterface, proxyUrl: string, adminToken: string, agentId: string): Promise<ReclaimResult> {
  const path = `/admin/vaults/${encodeURIComponent(agentId)}`
  return await reclaim(wallet, { proxyUrl, adminToken }, `${path}/utxo`, `${path}/reclaimed`, `vault ${agentId}`)
}

/** Takes back a request vault that was not spent (request failed, expired, denied at execute or price changed). */
export async function reclaimRequestVault (wallet: WalletInterface, proxyUrl: string, adminToken: string, requestId: string): Promise<ReclaimResult> {
  const path = `/admin/request-vaults/${encodeURIComponent(requestId)}`
  return await reclaim(wallet, { proxyUrl, adminToken }, `${path}/utxo`, `${path}/reclaimed`, `approval ${requestId}`)
}

async function reclaim (wallet: WalletInterface, admin: ProxyAdmin, utxoPath: string, reclaimedPath: string, label: string): Promise<ReclaimResult> {
  const utxo = await proxyCall<ReclaimableUtxo>(admin, utxoPath)

  // Check the script really is our vault before signing anything for it.
  const { publicKey: companyPub } = await walletCall('getPublicKey', async () => await wallet.getPublicKey({ protocolID: utxo.protocolID, keyID: utxo.keyID, counterparty: 'self' }))
  if (parseVaultSource(utxo.lockingScript)?.companyPub !== companyPub) throw new Error('this vault is not locked to the company key')
  const lockingScript = LockingScript.fromHex(utxo.lockingScript)

  // No outputs: the wallet's change output takes the funds back.
  const created = await walletCall('createAction', async () => await wallet.createAction({
    description: `Reclaim AgentTresor ${label}`.slice(0, 50),
    inputBEEF: Utils.toArray(utxo.beef, 'hex'),
    inputs: [{ outpoint: utxo.outpoint, unlockingScriptLength: RECLAIM_UNLOCK_LENGTH, inputDescription: 'AgentTresor vault' }],
    outputs: [],
    options: { signAndProcess: false, randomizeOutputs: false, acceptDelayedBroadcast: false }
  }))
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('the wallet did not return a transaction to sign')

  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const [txid, vout] = utxo.outpoint.split('.')
  const index = tx.inputs.findIndex(i => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === Number(vout))
  if (index === -1) throw new Error('vault input not found in the reclaim transaction')

  const { signature } = await walletCall('createSignature', async () => await wallet.createSignature({
    hashToDirectlySign: vaultSighash(tx, index, utxo.satoshis, lockingScript),
    protocolID: utxo.protocolID,
    keyID: utxo.keyID,
    counterparty: 'self'
  }))
  const unlockingScript = reclaimUnlockingScript(Signature.fromDER(Array.from(signature)))
  const signed = await walletCall('signAction', async () => await wallet.signAction({
    reference: signable.reference,
    spends: { [index]: { unlockingScript: unlockingScript.toHex() } },
    options: { acceptDelayedBroadcast: false }
  }))
  const reclaimTxid = signed.txid ?? (signed.tx === undefined ? undefined : Transaction.fromAtomicBEEF(signed.tx).id('hex'))
  if (reclaimTxid === undefined) throw new Error('the wallet did not sign the reclaim transaction')

  await proxyCall(admin, reclaimedPath, { txid: reclaimTxid })
  return { txid: reclaimTxid, satoshis: utxo.satoshis }
}
