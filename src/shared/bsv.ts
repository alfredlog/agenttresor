/**
 * Single runtime build of @bsv/sdk (guide §2, §23). Our code is ESM, but
 * wallet-toolbox is CommonJS and loads the CJS build of @bsv/sdk; importing the
 * ESM build as well would give two copies of every SDK class
 * (`script[serializedBytes] is not a function`). So src/ loads the SDK through
 * createRequire, which yields the same CJS module instance wallet-toolbox uses.
 *
 * Import SDK values from here, never from '@bsv/sdk' directly. Type-only
 * imports from '@bsv/sdk' are fine (they are erased). Tests keep the vitest
 * alias, which points '@bsv/sdk' at the same CJS file.
 */
import { createRequire } from 'node:module'
import type * as Sdk from '@bsv/sdk'

const sdk = createRequire(import.meta.url)('@bsv/sdk') as typeof Sdk

// Keep this list in sync with ./bsv.browser.ts (the browser bundle's stand-in).
export const Beef = sdk.Beef
export type Beef = Sdk.Beef
export const CachedKeyDeriver = sdk.CachedKeyDeriver
export type CachedKeyDeriver = Sdk.CachedKeyDeriver
export const Hash = sdk.Hash
export const KeyDeriver = sdk.KeyDeriver
export type KeyDeriver = Sdk.KeyDeriver
export const LockingScript = sdk.LockingScript
export type LockingScript = Sdk.LockingScript
export const OP = sdk.OP
export const P2PKH = sdk.P2PKH
export const PrivateKey = sdk.PrivateKey
export type PrivateKey = Sdk.PrivateKey
export const PublicKey = sdk.PublicKey
export type PublicKey = Sdk.PublicKey
export const Random = sdk.Random
export const SatoshisPerKilobyte = sdk.SatoshisPerKilobyte
export const Signature = sdk.Signature
export type Signature = Sdk.Signature
export const Spend = sdk.Spend
export const Transaction = sdk.Transaction
export type Transaction = Sdk.Transaction
export const TransactionSignature = sdk.TransactionSignature
export const UnlockingScript = sdk.UnlockingScript
export type UnlockingScript = Sdk.UnlockingScript
export const Utils = sdk.Utils
export const WalletClient = sdk.WalletClient

export type { ChainTracker, WalletInterface, WalletProtocol } from '@bsv/sdk'
