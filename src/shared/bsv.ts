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

export const CachedKeyDeriver = sdk.CachedKeyDeriver
export type CachedKeyDeriver = Sdk.CachedKeyDeriver
export const PrivateKey = sdk.PrivateKey
export type PrivateKey = Sdk.PrivateKey

export type { ChainTracker, WalletInterface } from '@bsv/sdk'
