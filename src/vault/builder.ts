/**
 * Builds unsigned vault payments.
 *  - From the agent's vault: input 0 = the vault UTXO, output 0 = the merchant's
 *    BRC-29 P2PKH, output 1 = change back to the same vault script.
 *  - From a request vault (funded by the company for one approved payment):
 *    one input, one output paying the merchant; the rest is the fee.
 * Either form may end with one 0-sat OP_RETURN anchoring the audit log head
 * (src/audit/anchor-script.ts), so payments anchor the log as they go.
 * A v2 vault (./covenant.ts) needs a larger unlocking script and a ground
 * nLockTime; the builder sizes the fee for it and grinds.
 */
import { LockingScript, SatoshisPerKilobyte, Transaction, UnlockingScript } from '../shared/bsv.js'
import { anchorLockingScript } from '../audit/anchor-script.js'
import { covenantSpendUnlockLength, grindLockTime, parseCovenantScript } from './covenant.js'
import { SPEND_UNLOCK_LENGTH } from './script.js'

export const FEE_SATS_PER_KB = 100

export interface VaultOutpoint {
  txid: string
  vout: number
  satoshis: number
  lockingScript: string
}

export interface UnsignedVaultPayment {
  tx: Transaction
  feeSats: number
  changeSats: number
  /** nLockTime values tried to ground a v2 payment (0 for v1). */
  grindTries: number
}

/** A P2PKH output stands in for the merchant when only the fee matters. */
const PLACEHOLDER_P2PKH = LockingScript.fromHex(`76a914${'00'.repeat(20)}88ac`)

/** An anchor at least as large as any real one (a 10-digit seq), for sizing fees before the head is known. */
export const PLACEHOLDER_ANCHOR = anchorLockingScript('00'.repeat(32), 9_999_999_999)

/** Sizes the fee of a vault input: <sigPolicy> <sigAgent> OP_1. */
interface SizingTemplate {
  sign: () => Promise<never>
  estimateLength: (tx: Transaction) => Promise<number>
}

const spendTemplate: SizingTemplate = {
  sign: async (): Promise<never> => { throw new Error('vault inputs are signed by the agent and the policy') },
  estimateLength: async () => SPEND_UNLOCK_LENGTH
}

/** Sizes the fee of a v2 vault input: <sigPolicy> <sigAgent> <outputsBlob> <preimage> OP_1. */
const covenantTemplate = (lockingScriptLength: number): SizingTemplate => ({
  sign: spendTemplate.sign,
  estimateLength: async (tx: Transaction) => covenantSpendUnlockLength(tx, lockingScriptLength)
})

/** Fee and change for paying `sats`; `changeSats` < 1 means the vault cannot cover it. */
export async function buildVaultPayment (utxo: VaultOutpoint, sats: number, merchantScript: LockingScript = PLACEHOLDER_P2PKH, anchorScript?: LockingScript): Promise<UnsignedVaultPayment> {
  const vaultScript = LockingScript.fromHex(utxo.lockingScript)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: utxo.txid,
    sourceOutputIndex: utxo.vout,
    sequence: 0xffffffff,
    unlockingScriptTemplate: parseCovenantScript(vaultScript) === undefined ? spendTemplate : covenantTemplate(vaultScript.toBinary().length)
  })
  tx.addOutput({ satoshis: sats, lockingScript: merchantScript })
  tx.addOutput({ satoshis: 0, lockingScript: vaultScript })
  if (anchorScript !== undefined) tx.addOutput({ satoshis: 0, lockingScript: anchorScript })
  // The change amount does not change the size, so the fee is final before it is set.
  const feeSats = await new SatoshisPerKilobyte(FEE_SATS_PER_KB).computeFee(tx)
  const changeSats = utxo.satoshis - sats - feeSats
  tx.outputs[1].satoshis = changeSats
  tx.inputs[0].unlockingScriptTemplate = undefined
  tx.inputs[0].unlockingScript = new UnlockingScript()
  // v2: the OP_PUSH_TX signature needs a ground nLockTime (sizes do not change, so the fee holds).
  const grindTries = changeSats >= 1 && parseCovenantScript(vaultScript) !== undefined ? grindLockTime(tx, 0, utxo.satoshis, vaultScript) : 0
  return { tx, feeSats, changeSats, grindTries }
}

/**
 * Fee of a request-vault payment (1 vault input, 1 P2PKH output, room for an
 * anchor). The company funds price + this fee, so the vault holds exactly what
 * the payment needs.
 */
export async function requestVaultFee (): Promise<number> {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScriptTemplate: spendTemplate })
  tx.addOutput({ satoshis: 1, lockingScript: PLACEHOLDER_P2PKH })
  tx.addOutput({ satoshis: 0, lockingScript: PLACEHOLDER_ANCHOR })
  return await new SatoshisPerKilobyte(FEE_SATS_PER_KB).computeFee(tx)
}

/** Request-vault payment: everything the vault holds beyond `sats` goes to the fee. */
export function buildRequestVaultPayment (utxo: VaultOutpoint, sats: number, merchantScript: LockingScript, anchorScript?: LockingScript): UnsignedVaultPayment {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: utxo.txid, sourceOutputIndex: utxo.vout, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: sats, lockingScript: merchantScript })
  if (anchorScript !== undefined) tx.addOutput({ satoshis: 0, lockingScript: anchorScript })
  return { tx, feeSats: utxo.satoshis - sats, changeSats: 0, grindTries: 0 }
}
