/**
 * Company side of the vault, written against BRC-100's WalletInterface: the
 * browser page passes `new WalletClient('auto')` (BSV Desktop), tests pass a
 * wallet-toolbox wallet. The company's key never leaves its wallet.
 *
 *  - fundVault: lock `sats` in this agent's vault script (agent AND policy, or company alone).
 *  - reclaimVault: take the whole vault back with the company signature alone.
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

export interface ReclaimResult {
  txid: string
  satoshis: number
}

export async function reclaimVault (wallet: WalletInterface, proxyUrl: string, adminToken: string, agentId: string): Promise<ReclaimResult> {
  const admin = { proxyUrl, adminToken }
  const id = encodeURIComponent(agentId)
  const utxo = await proxyCall<{ outpoint: string, satoshis: number, lockingScript: string, beef: string, protocolID: WalletProtocol, keyID: string }>(admin, `/admin/vaults/${id}/utxo`)

  // Check the script really is our vault before signing anything for it.
  const { publicKey: companyPub } = await wallet.getPublicKey({ protocolID: utxo.protocolID, keyID: utxo.keyID, counterparty: 'self' })
  if (parseVaultScript(utxo.lockingScript)?.companyPub !== companyPub) throw new Error('this vault is not locked to the company key')
  const lockingScript = LockingScript.fromHex(utxo.lockingScript)

  // No outputs: the wallet's change output takes the funds back.
  const created = await wallet.createAction({
    description: `Reclaim AgentTresor vault ${agentId}`.slice(0, 50),
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

  await proxyCall(admin, `/admin/vaults/${id}/reclaimed`, { txid: reclaimTxid })
  return { txid: reclaimTxid, satoshis: utxo.satoshis }
}
