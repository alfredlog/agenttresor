/**
 * Deterministic receive keys (BRC-42 with counterparty 'anyone').
 *
 * Key `keyID` of identity I under protocol P is derived with the public
 * "anyone" key (private key 1), so ANYONE who knows I can compute it — the
 * sender, the overlay, a block explorer — and the owner's wallet derives the
 * matching private key with `counterparty: 'anyone', forSelf: true`.
 *
 * Tokens use numbered keys (keyID "0", "1", …) so the overlay can scan an
 * identity's addresses. NFTs use a random keyID that travels with the delivery.
 *
 * Trade-off (accepted for this kit): holdings are publicly linkable to the
 * identity key.
 */
import { KeyDeriver, PublicKey, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

/** Security level 1: the wallet asks once per app (level 0 would never ask). */
export const TOKEN_PROTOCOL: WalletProtocol = [1, 'bsv21 token']
export const ORDINAL_PROTOCOL: WalletProtocol = [1, 'one sat ordinals']
export const TOKEN_BASKET = 'bsv21'
export const ORDINALS_BASKET = 'ordinals'
/** Unused indices scanned past the highest used one (like an HD wallet gap limit). */
export const GAP_LIMIT = 20

export const keyIdFor = (index: number): string => `${index}`

const anyone = new KeyDeriver('anyone')

/** Public key `keyID` of `identityKey` under `protocol`, computable by anyone. */
export function anyonePublicKey (identityKey: string, keyID: string, protocol: WalletProtocol = TOKEN_PROTOCOL): PublicKey {
  return anyone.derivePublicKey(protocol, keyID, identityKey)
}

/** HASH160 (hex) of that key — what a P2PKH-suffixed output locks to. */
export function anyonePkh (identityKey: string, keyID: string, protocol: WalletProtocol = TOKEN_PROTOCOL): string {
  return anyonePublicKey(identityKey, keyID, protocol).toHash('hex') as string
}

/** Token receive key #index of `identityKey`. */
export const receivePublicKey = (identityKey: string, index: number): PublicKey => anyonePublicKey(identityKey, keyIdFor(index))
export const receivePkh = (identityKey: string, index: number): string => anyonePkh(identityKey, keyIdFor(index))

/** The owner's view of the same key, derived by their wallet (must equal anyonePublicKey). */
export async function ownPublicKey (
  wallet: Pick<WalletInterface, 'getPublicKey'>,
  keyID: string,
  protocol: WalletProtocol = TOKEN_PROTOCOL,
  originator?: string
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ protocolID: protocol, keyID, counterparty: 'anyone', forSelf: true }, originator)
  return publicKey
}

export const ownReceivePublicKey = async (wallet: Pick<WalletInterface, 'getPublicKey'>, index: number, originator?: string): Promise<string> =>
  await ownPublicKey(wallet, keyIdFor(index), TOKEN_PROTOCOL, originator)

/** Stored with each basket output so the app can sign for it later. */
export interface CustomInstructions {
  protocolID: WalletProtocol
  keyID: string
  counterparty: 'anyone'
  /** Receive-key index (tokens only). */
  index?: number
}

export const instructionsFor = (index: number): CustomInstructions => ({
  protocolID: TOKEN_PROTOCOL,
  keyID: keyIdFor(index),
  counterparty: 'anyone',
  index
})
