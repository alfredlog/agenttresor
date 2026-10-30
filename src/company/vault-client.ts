/**
 * Company side of the vault, written against BRC-100's WalletInterface: the
 * browser page passes `new WalletClient('auto')` (BSV Desktop), tests pass a
 * wallet-toolbox wallet. The company's key never leaves its wallet.
 *
 *  - fundVault: lock `sats` in this agent's vault script (agent AND policy, or company alone).
 *  - approveAndFund: approve one payment above the threshold by funding a request
 *    vault (same script) with exactly its price + fee. Without it the payment is impossible.
 *  - reclaimVault / reclaimRequestVault: take a vault back with the company signature alone.
 */
import { LockingScript, Signature, Transaction, Utils, type WalletInterface, type WalletProtocol } from '../shared/bsv.js'
import { parseVaultScript, reclaimUnlockingScript, RECLAIM_UNLOCK_LENGTH, vaultLockingScript, vaultSighash } from '../vault/script.js'

export interface ProxyAdmin {
  proxyUrl: string
  adminToken: string
}

async function proxyCall<T> (admin: ProxyAdmin, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${admin.proxyUrl.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `proxy answered ${res.status}`)
  return json
}

export interface FundResult {
  txid: string
  vout: number
  satoshis: number
}

export async function fundVault (wallet: WalletInterface, proxyUrl: string, adminToken: string, agentId: string, sats: number): Promise<FundResult> {
  if (!Number.isSafeInteger(sats) || sats < 1) throw new Error('amount must be a positive number of satoshis')
  const admin = { proxyUrl, adminToken }
  const id = encodeURIComponent(agentId)
  const params = await proxyCall<{ agentPub: string, policyPub: string, protocolID: WalletProtocol, keyID: string }>(admin, `/admin/vaults/${id}/params`)
  const { publicKey: companyPub } = await wallet.getPublicKey({ protocolID: params.protocolID, keyID: params.keyID, counterparty: 'self' })
  const lockingScript = vaultLockingScript({ agentPub: params.agentPub, policyPub: params.policyPub, companyPub }).toHex()

  const created = await wallet.createAction({
    description: `Fund AgentTresor vault ${agentId}`.slice(0, 50),
    outputs: [{ lockingScript, satoshis: sats, outputDescription: 'AgentTresor vault' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
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
export async function approveAndFund (wallet: WalletInterface, proxyUrl: string, adminToken: string, requestId: string): Promise<FundResult> {
  const admin = { proxyUrl, adminToken }
  const id = encodeURIComponent(requestId)
  const a = await getApproval(proxyUrl, adminToken, requestId)
  const { publicKey: companyPub } = await wallet.getPublicKey({ protocolID: a.protocolID, keyID: a.keyID, counterparty: 'self' })
  const lockingScript = vaultLockingScript({ agentPub: a.agentPub, policyPub: a.policyPub, companyPub }).toHex()

  const created = await wallet.createAction({
    description: `Approve AgentTresor payment ${requestId}`.slice(0, 50),
    outputs: [{ lockingScript, satoshis: a.totalSats, outputDescription: `Approved payment ${requestId}`.slice(0, 50) }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
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
  const { publicKey: companyPub } = await wallet.getPublicKey({ protocolID: utxo.protocolID, keyID: utxo.keyID, counterparty: 'self' })
  if (parseVaultScript(utxo.lockingScript)?.companyPub !== companyPub) throw new Error('this vault is not locked to the company key')
  const lockingScript = LockingScript.fromHex(utxo.lockingScript)

  // No outputs: the wallet's change output takes the funds back.
  const created = await wallet.createAction({
    description: `Reclaim AgentTresor ${label}`.slice(0, 50),
    inputBEEF: Utils.toArray(utxo.beef, 'hex'),
    inputs: [{ outpoint: utxo.outpoint, unlockingScriptLength: RECLAIM_UNLOCK_LENGTH, inputDescription: 'AgentTresor vault' }],
    outputs: [],
    options: { signAndProcess: false, randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('the wallet did not return a transaction to sign')

  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const [txid, vout] = utxo.outpoint.split('.')
  const index = tx.inputs.findIndex(i => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === Number(vout))
  if (index === -1) throw new Error('vault input not found in the reclaim transaction')

  const { signature } = await wallet.createSignature({
    hashToDirectlySign: vaultSighash(tx, index, utxo.satoshis, lockingScript),
    protocolID: utxo.protocolID,
    keyID: utxo.keyID,
    counterparty: 'self'
  })
  const unlockingScript = reclaimUnlockingScript(Signature.fromDER(Array.from(signature)))
  const signed = await wallet.signAction({
    reference: signable.reference,
    spends: { [index]: { unlockingScript: unlockingScript.toHex() } },
    options: { acceptDelayedBroadcast: false }
  })
  const reclaimTxid = signed.txid ?? (signed.tx === undefined ? undefined : Transaction.fromAtomicBEEF(signed.tx).id('hex'))
  if (reclaimTxid === undefined) throw new Error('the wallet did not sign the reclaim transaction')

  await proxyCall(admin, reclaimedPath, { txid: reclaimTxid })
  return { txid: reclaimTxid, satoshis: utxo.satoshis }
}
