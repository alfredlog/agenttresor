/**
 * Agent side of a vault payment. The proxy answers POST /v1/pay (or /execute)
 * with { status: 'sign', unsignedTx, … }; the agent checks the transaction
 * against what it asked for and only then signs it with its own key.
 *
 * Checked before signing:
 *  - exactly one input, locked by a vault script that names this agent's key;
 *  - output 0 pays exactly the price the agent expects, to the announced script;
 *  - output 1 returns the change to the same vault script, and there is nothing else;
 *  - the fee (input - outputs) is what the proxy announced, and at most `maxFeeSats`.
 * The input value comes from the proxy, but BIP-143 signs it: if it is wrong,
 * the signature is invalid on chain and nothing can be spent with it.
 */
import { LockingScript, Transaction, type PrivateKey } from '../shared/bsv.js'
import { parseVaultScript, signVaultInput } from '../vault/script.js'

export interface VaultSignAnswer {
  status: 'sign'
  requestId: string
  unsignedTx: string
  sourceSatoshis: number
  sourceLockingScript: string
  merchantOutput: { satoshis: number, lockingScript: string }
  feeSats: number
}

export interface SignOptions {
  /** The highest fee the agent accepts (default 1000 sats). */
  maxFeeSats?: number
}

const P2PKH = /^76a914[0-9a-f]{40}88ac$/

/** Checks the payment and returns the agent's DER signature (hex). Throws if anything is off. */
export function signVaultPayment (answer: VaultSignAnswer, agentKey: PrivateKey, expectedPriceSats: number, opts: SignOptions = {}): string {
  const maxFeeSats = opts.maxFeeSats ?? 1000
  const refuse = (why: string): never => { throw new Error(`refusing to sign vault payment ${answer.requestId}: ${why}`) }

  if (answer.status !== 'sign') refuse(`status is ${String(answer.status)}`)
  const vaultKeys = parseVaultScript(answer.sourceLockingScript)
  if (vaultKeys === undefined) refuse('the input is not a vault script')
  if (vaultKeys!.agentPub !== agentKey.toPublicKey().toString()) refuse('the vault does not belong to this agent key')

  const tx = Transaction.fromHex(answer.unsignedTx)
  if (tx.inputs.length !== 1) refuse(`expected 1 input, got ${tx.inputs.length}`)
  if (tx.outputs.length !== 2) refuse(`expected 2 outputs, got ${tx.outputs.length}`)
  const [pay, change] = tx.outputs
  if (pay.satoshis !== expectedPriceSats) refuse(`output 0 pays ${String(pay.satoshis)} sats, expected ${expectedPriceSats}`)
  if (answer.merchantOutput.satoshis !== expectedPriceSats) refuse('the announced price differs from the expected price')
  if (pay.lockingScript.toHex() !== answer.merchantOutput.lockingScript || !P2PKH.test(answer.merchantOutput.lockingScript)) {
    refuse('output 0 is not the announced merchant P2PKH output')
  }
  if (change.lockingScript.toHex() !== answer.sourceLockingScript) refuse('output 1 does not return the change to the vault')

  const fee = answer.sourceSatoshis - expectedPriceSats - (change.satoshis ?? 0)
  if (!Number.isSafeInteger(fee) || fee < 0) refuse('outputs exceed the vault balance')
  if (fee !== answer.feeSats) refuse(`fee is ${fee} sats, announced ${answer.feeSats}`)
  if (fee > maxFeeSats) refuse(`fee ${fee} sats is above the limit of ${maxFeeSats}`)

  return signVaultInput(agentKey, tx, 0, answer.sourceSatoshis, LockingScript.fromHex(answer.sourceLockingScript)).toDER('hex') as string
}
