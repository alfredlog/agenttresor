/**
 * The AgentTresor vault: one UTXO per agent, locked by
 *
 *   OP_IF   <agentPub> OP_CHECKSIGVERIFY <policyPub> OP_CHECKSIG
 *   OP_ELSE <companyPub> OP_CHECKSIG
 *   OP_ENDIF
 *
 * Spend path (agent AND policy):  <sigPolicy> <sigAgent> OP_1
 * Reclaim path (company alone):   <sigCompany> OP_0
 *
 * Neither the proxy (policy key) nor the agent can move funds alone; the
 * company can always take everything back. Signatures are SIGHASH_ALL |
 * SIGHASH_FORKID over the BIP-143 preimage; the signed digest is hash256(preimage).
 */
import { Hash, LockingScript, OP, PublicKey, Signature, TransactionSignature, UnlockingScript, Utils, type PrivateKey, type Transaction } from '../shared/bsv.js'

export interface VaultKeys {
  agentPub: string
  policyPub: string
  companyPub: string
}

export const SIGHASH_SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

/** A checksig signature push: 1 length byte + up to 72 bytes DER + 1 sighash byte. */
const SIG_PUSH = 74
/** <sigPolicy> <sigAgent> OP_1 */
export const SPEND_UNLOCK_LENGTH = 2 * SIG_PUSH + 1
/** <sigCompany> OP_0 */
export const RECLAIM_UNLOCK_LENGTH = SIG_PUSH + 1

const isCompressedPub = (hex: string): boolean => {
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) return false
  try { return PublicKey.fromString(hex).toString() === hex } catch { return false }
}

const push = (data: number[]): { op: number, data: number[] } => ({ op: data.length, data })

export function vaultLockingScript (keys: VaultKeys): LockingScript {
  for (const [name, pub] of Object.entries(keys)) {
    if (!isCompressedPub(pub)) throw new Error(`${name} must be a compressed public key`)
  }
  const pub = (hex: string): { op: number, data: number[] } => push(Utils.toArray(hex, 'hex'))
  return new LockingScript([
    { op: OP.OP_IF },
    pub(keys.agentPub), { op: OP.OP_CHECKSIGVERIFY },
    pub(keys.policyPub), { op: OP.OP_CHECKSIG },
    { op: OP.OP_ELSE },
    pub(keys.companyPub), { op: OP.OP_CHECKSIG },
    { op: OP.OP_ENDIF }
  ])
}

/** The three keys of a vault script, or undefined if the script is not exactly a vault script. */
export function parseVaultScript (script: LockingScript | string): VaultKeys | undefined {
  const s = typeof script === 'string' ? LockingScript.fromHex(script) : script
  const c = s.chunks
  if (c.length !== 9) return undefined
  const hex = (i: number): string => c[i].data === undefined ? '' : Utils.toHex(c[i].data!)
  const keys = { agentPub: hex(1), policyPub: hex(3), companyPub: hex(6) }
  try {
    return vaultLockingScript(keys).toHex() === s.toHex() ? keys : undefined
  } catch {
    return undefined
  }
}

/** BIP-143 preimage of one input (all inputs need sourceTXID or sourceTransaction). */
export function vaultPreimage (tx: Transaction, inputIndex: number, sourceSatoshis: number, lockingScript: LockingScript): number[] {
  const input = tx.inputs[inputIndex]
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID === undefined) throw new Error(`input ${inputIndex} has no source txid`)
  return TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: lockingScript,
    lockTime: tx.lockTime,
    scope: SIGHASH_SCOPE
  })
}

/** The digest a wallet signs with createSignature({ hashToDirectlySign }). */
export function vaultSighash (tx: Transaction, inputIndex: number, sourceSatoshis: number, lockingScript: LockingScript): number[] {
  return Hash.hash256(vaultPreimage(tx, inputIndex, sourceSatoshis, lockingScript))
}

/** Signs a vault input with a local key. PrivateKey.sign hashes once more, so the digest is hash256(preimage). */
export function signVaultInput (key: PrivateKey, tx: Transaction, inputIndex: number, sourceSatoshis: number, lockingScript: LockingScript): Signature {
  return key.sign(Hash.sha256(vaultPreimage(tx, inputIndex, sourceSatoshis, lockingScript)))
}

export function verifyVaultSignature (pub: string, sig: Signature, tx: Transaction, inputIndex: number, sourceSatoshis: number, lockingScript: LockingScript): boolean {
  try {
    return PublicKey.fromString(pub).verify(Hash.sha256(vaultPreimage(tx, inputIndex, sourceSatoshis, lockingScript)), sig)
  } catch {
    return false
  }
}

/** DER signature + sighash byte, as OP_CHECKSIG expects it. */
export function checksigBytes (sig: Signature): number[] {
  return new TransactionSignature(sig.r, sig.s, SIGHASH_SCOPE).toChecksigFormat()
}

export function spendUnlockingScript (policySig: Signature, agentSig: Signature): UnlockingScript {
  return new UnlockingScript([push(checksigBytes(policySig)), push(checksigBytes(agentSig)), { op: OP.OP_1 }])
}

export function reclaimUnlockingScript (companySig: Signature): UnlockingScript {
  return new UnlockingScript([push(checksigBytes(companySig)), { op: OP.OP_0 }])
}

/** Parses a DER signature given as hex; throws on malformed input. */
export function signatureFromDerHex (hex: string): Signature {
  if (!/^[0-9a-f]{16,146}$/i.test(hex)) throw new Error('signature must be DER hex')
  return Signature.fromDER(Utils.toArray(hex, 'hex'))
}
