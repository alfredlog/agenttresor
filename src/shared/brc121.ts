/**
 * BRC-121 Simple 402 Payments (@bsv/402-pay 0.3.3), loaded through createRequire
 * so its @bsv/sdk imports resolve to the same CJS build as wallet-toolbox
 * (see ./bsv.ts). Import 402-pay from here, never from '@bsv/402-pay' directly.
 */
import { createRequire } from 'node:module'
import type * as Server from '@bsv/402-pay/server'
import type * as Client from '@bsv/402-pay/client'
import type { WalletInterface } from './bsv.js'

const require = createRequire(import.meta.url)
const server = require('@bsv/402-pay/server') as typeof Server
const client = require('@bsv/402-pay/client') as typeof Client

export const createPaymentMiddleware = server.createPaymentMiddleware
export const InMemoryPaymentReplayStore = server.InMemoryPaymentReplayStore
export type InMemoryPaymentReplayStore = Server.InMemoryPaymentReplayStore
export type { PaymentResult, PaymentReplayStore } from '@bsv/402-pay/server'

export const create402Fetch = client.create402Fetch
export const constructPaymentHeaders = client.constructPaymentHeaders
export type { PaymentHeaders } from '@bsv/402-pay/client'

/** BRC-121 challenge headers. */
export const HEADER_SATS = 'x-bsv-sats'
export const HEADER_SERVER = 'x-bsv-server'

/**
 * @bsv/402-pay 0.3.3's client passes the request origin WITH its scheme
 * ("https://api.example.com") as the BRC-100 originator; wallet-toolbox wallets
 * require a bare hostname ("api.example.com") and reject the call. Wrap a
 * wallet-toolbox wallet with this before giving it to create402Fetch /
 * constructPaymentHeaders (guide §10.4).
 */
export function withHostOriginator (wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get (target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (args: unknown, originator?: string) =>
        value.call(target, args, typeof originator === 'string' ? originator.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : originator)
    }
  })
}
