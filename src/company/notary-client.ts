/**
 * Company side of the notary top-up, written against BRC-100's WalletInterface
 * (BSV Desktop in the browser, a wallet-toolbox wallet in tests): a BRC-29
 * payment to the notary's identity key, which the proxy verifies and
 * internalizes. It pays anchoring fees only; the notary can do nothing else
 * with it.
 */
import { P2PKH, PublicKey, Random, Transaction, Utils, type WalletInterface, type WalletProtocol } from '../shared/bsv.js'
import { proxyCall } from './vault-client.js'

const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

export interface NotaryInfo {
  enabled: boolean
  reason?: string
  identityKey?: string
  balanceSats?: number
  maxSats?: number
  topUpRoomSats?: number
}

export interface TopUpResult {
  txid: string
  satoshis: number
  balanceSats: number
}

export async function getNotary (proxyUrl: string, adminToken: string): Promise<NotaryInfo> {
  return await proxyCall<NotaryInfo>({ proxyUrl, adminToken }, '/admin/notary')
}

/** Pays `satoshis` to the notary (sender side of BRC-29: counterparty = the notary, forSelf: false). */
export async function topUpNotary (wallet: WalletInterface, proxyUrl: string, adminToken: string, satoshis: number): Promise<TopUpResult> {
  const info = await getNotary(proxyUrl, adminToken)
  if (!info.enabled || info.identityKey === undefined) throw new Error(`the notary is disabled: ${info.reason ?? 'unknown reason'}`)
  if (!Number.isSafeInteger(satoshis) || satoshis < 1) throw new Error('the amount must be a whole number of satoshis')
  // Checked before paying: the proxy refuses a top-up over the cap, and the payment could not be taken back.
  const room = info.topUpRoomSats ?? 0
  if (satoshis > room) throw new Error(`the notary keeps at most ${info.maxSats ?? 0} sats: top up ${room} sats or less`)

  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: info.identityKey,
    forSelf: false
  })
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()
  const created = await wallet.createAction({
    description: 'Top up AgentTresor notary (anchor fees)',
    outputs: [{ lockingScript, satoshis, outputDescription: 'AgentTresor notary anchor fees' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (created.tx === undefined || created.txid === undefined) throw new Error('the wallet did not create the top-up transaction')
  // Find the payment output by its locking script, never by position.
  const outputIndex = Transaction.fromAtomicBEEF(created.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  if (outputIndex === -1) throw new Error('top-up output not found in the transaction')
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true })
  return await proxyCall<TopUpResult>({ proxyUrl, adminToken }, '/admin/notary/topup', {
    beef: Utils.toHex(Array.from(created.tx)), outputIndex, derivationPrefix, derivationSuffix, senderIdentityKey
  })
}
