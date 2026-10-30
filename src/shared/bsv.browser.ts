/**
 * Browser stand-in for ./bsv.ts. The browser bundle (scripts/build-web.mjs)
 * swaps it in, because createRequire only exists in Node; in a browser there is
 * no wallet-toolbox, so the ESM build of @bsv/sdk is the only copy.
 * Keep the export list identical to ./bsv.ts.
 */
export {
  Beef, CachedKeyDeriver, Hash, KeyDeriver, LockingScript, OP, P2PKH, PrivateKey, PublicKey, Random,
  SatoshisPerKilobyte, Script, Signature, Spend, Transaction, TransactionSignature, UnlockingScript, Utils, WalletClient
} from '@bsv/sdk'
export type { ChainTracker, WalletInterface, WalletProtocol } from '@bsv/sdk'
