/**
 * Builds unsigned vault payments.
 *  - From the agent's vault: input 0 = the vault UTXO, output 0 = the merchant's
 *    BRC-29 P2PKH, output 1 = change back to the same vault script.
 *  - From a request vault (funded by the company for one approved payment):
 *    one input, one output paying the merchant; the rest is the fee.
 */
import { LockingScript, SatoshisPerKilobyte, Transaction, UnlockingScript } from '../shared/bsv.js'
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
}

/** A P2PKH output stands in for the merchant when only the fee matters. */
const PLACEHOLDER_P2PKH = LockingScript.fromHex(`76a914${'00'.repeat(20)}88ac`)

/** Sizes the fee of a vault input: <sigPolicy> <sigAgent> OP_1. */
const spendTemplate = {
  sign: async (): Promise<never> => { throw new Error('vault inputs are signed by the agent and the policy') },
  estimateLength: async () => SPEND_UNLOCK_LENGTH
}

/** Fee and change for paying `sats`; `changeSats` < 1 means the vault cannot cover it. */
export async function buildVaultPayment (utxo: VaultOutpoint, sats: number, merchantScript: LockingScript = PLACEHOLDER_P2PKH): Promise<UnsignedVaultPayment> {
  const vaultScript = LockingScript.fromHex(utxo.lockingScript)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: utxo.txid,
    sourceOutputIndex: utxo.vout,
    sequence: 0xffffffff,
    unlockingScriptTemplate: spendTemplate
  })
  tx.addOutput({ satoshis: sats, lockingScript: merchantScript })
  tx.addOutput({ satoshis: 0, lockingScript: vaultScript })
  // The change amount does not change the size, so the fee is final before it is set.
  const feeSats = await new SatoshisPerKilobyte(FEE_SATS_PER_KB).computeFee(tx)
  const changeSats = utxo.satoshis - sats - feeSats
  tx.outputs[1].satoshis = changeSats
  tx.inputs[0].unlockingScriptTemplate = undefined
  tx.inputs[0].unlockingScript = new UnlockingScript()
  return { tx, feeSats, changeSats }
}

/**
 * Fee of a request-vault payment (1 vault input, 1 P2PKH output). The company
 * funds price + this fee, so the vault holds exactly what the payment needs.
 */
export async function requestVaultFee (): Promise<number> {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScriptTemplate: spendTemplate })
  tx.addOutput({ satoshis: 1, lockingScript: PLACEHOLDER_P2PKH })
  return await new SatoshisPerKilobyte(FEE_SATS_PER_KB).computeFee(tx)
}

/** Request-vault payment: everything the vault holds beyond `sats` goes to the fee. */
export function buildRequestVaultPayment (utxo: VaultOutpoint, sats: number, merchantScript: LockingScript): UnsignedVaultPayment {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: utxo.txid, sourceOutputIndex: utxo.vout, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: sats, lockingScript: merchantScript })
  return { tx, feeSats: utxo.satoshis - sats, changeSats: 0 }
}
