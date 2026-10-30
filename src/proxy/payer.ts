/**
 * Who pays the merchant. Block 3 pays from the proxy's own server wallet;
 * block 4 swaps in the non-custodial vault behind the same interface.
 */
import { Transaction, Utils, type WalletInterface } from '../shared/bsv.js'
import { constructPaymentHeaders, withHostOriginator, type PaymentHeaders } from '../shared/brc121.js'

export interface Payer {
  /**
   * Builds BRC-121 payment headers for `sats` to the merchant `serverKey`.
   * The payment leaves the wallet as soon as this resolves.
   */
  pay: (url: string, sats: number, serverKey: string) => Promise<PaymentHeaders>
}

export class WalletPayer implements Payer {
  private readonly wallet: WalletInterface

  constructor (wallet: WalletInterface) {
    this.wallet = withHostOriginator(wallet)
  }

  async pay (url: string, sats: number, serverKey: string): Promise<PaymentHeaders> {
    return await constructPaymentHeaders(this.wallet, url, sats, serverKey)
  }
}

/** The payment transaction's id, from the x-bsv-beef header (AtomicBEEF, base64). */
export function paymentTxid (headers: PaymentHeaders): string {
  return Transaction.fromAtomicBEEF(Utils.toArray(headers['x-bsv-beef'], 'base64')).id('hex')
}
