/**
 * Unlock a P2PKH-suffixed output (BSV-21 tokens, 1Sat NFTs, plain P2PKH) with
 * a BRC-100 wallet.
 *
 * The app computes the BIP-143 preimage over the FULL source locking script
 * (inscription + P2PKH) and asks the wallet to sign its hash with the derived
 * key — the private key never leaves the wallet.
 */
import {
  Hash,
  Signature,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type Transaction,
  type WalletInterface,
  type WalletProtocol
} from '@bsv/sdk'
import { keyIdFor, TOKEN_PROTOCOL } from './addresses'

/** <73-byte checksig sig push> + <33-byte pubkey push>. */
export const P2PKH_UNLOCK_LENGTH = 108
const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

export interface KeyRef {
  protocolID: WalletProtocol
  keyID: string
}

export async function signWalletP2pkhInput (
  wallet: WalletInterface,
  tx: Transaction,
  inputIndex: number,
  key: KeyRef,
  originator?: string
): Promise<UnlockingScript> {
  const input = tx.inputs[inputIndex]
  const sourceTx = input.sourceTransaction
  if (sourceTx === undefined) throw new Error(`input ${inputIndex} has no source transaction`)
  const source = sourceTx.outputs[input.sourceOutputIndex]
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? sourceTx.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope: SCOPE
  })
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.hash256(preimage),
    protocolID: key.protocolID,
    keyID: key.keyID,
    counterparty: 'anyone'
  }, originator)
  const { publicKey } = await wallet.getPublicKey({ protocolID: key.protocolID, keyID: key.keyID, counterparty: 'anyone', forSelf: true }, originator)
  const sig = Signature.fromDER([...signature])
  const checksig = new TransactionSignature(sig.r, sig.s, SCOPE).toChecksigFormat()
  const pub = Utils.toArray(publicKey, 'hex')
  return new UnlockingScript([
    { op: checksig.length, data: checksig },
    { op: pub.length, data: pub }
  ])
}

/** Token input locked to receive key #keyIndex. */
export const signTokenInput = async (
  wallet: WalletInterface,
  tx: Transaction,
  inputIndex: number,
  keyIndex: number,
  originator?: string
): Promise<UnlockingScript> =>
  await signWalletP2pkhInput(wallet, tx, inputIndex, { protocolID: TOKEN_PROTOCOL, keyID: keyIdFor(keyIndex) }, originator)
