/**
 * Two wallet-toolbox wallets on the mock chain pay each other with BRC-29
 * (guide §9), offline and at 0-conf: no block is mined during the payments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { P2PKH, PublicKey, Random, Transaction, Utils, type ChainTracker, type WalletProtocol } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createMockChain, type MockChain } from './helpers/mockchain'

const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

interface Brc29Payment {
  tx: number[]
  txid: string
  outputIndex: number
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

/** Sender side: derive the recipient's key (counterparty = recipient, forSelf: false). */
async function pay (wallet: Wallet, recipientIdentityKey: string, satoshis: number): Promise<Brc29Payment> {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey,
    forSelf: false
  })
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const res = await wallet.createAction({
    description: 'BRC-29 payment',
    outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 payment' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (res.txid === undefined || res.tx === undefined) throw new Error('payment was not completed by the wallet')
  const outputIndex = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  if (outputIndex === -1) throw new Error('payment output not found in the transaction')
  return { tx: Array.from(res.tx), txid: res.txid, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey: wallet.identityKey }
}

/** Recipient side: verify SPV, check the output is ours (counterparty = sender, forSelf: true), internalize. */
async function accept (wallet: Wallet, p: Brc29Payment, chainTracker: ChainTracker): Promise<void> {
  const tx = Transaction.fromAtomicBEEF(p.tx)
  if (!(await tx.verify(chainTracker))) throw new Error('payment failed SPV verification')
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
    counterparty: p.senderIdentityKey,
    forSelf: true
  })
  const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const out = tx.outputs[p.outputIndex]
  if (out === undefined || out.lockingScript.toHex() !== expected) throw new Error('payment output is not locked to our key')
  if (out.satoshis !== p.satoshis) throw new Error(`payment is ${String(out.satoshis)} sats, not ${p.satoshis}`)
  await wallet.internalizeAction({
    tx: p.tx,
    outputs: [{
      outputIndex: p.outputIndex,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: p.derivationPrefix, derivationSuffix: p.derivationSuffix, senderIdentityKey: p.senderIdentityKey }
    }],
    description: 'Payment received'
  })
}

let chain: MockChain
const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const isMined = async (txid: string): Promise<boolean> =>
  (await (chain.services as any).storage.getTransaction(txid))?.blockHeight != null

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { await chain?.close() })

describe('BRC-29 payments between two wallet-toolbox wallets', () => {
  let alice: Wallet, bob: Wallet

  it('Alice pays Bob; Bob verifies SPV and internalizes', async () => {
    ;[alice, bob] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    const payment = await pay(alice, bob.identityKey, 50_000)
    expect(await isMined(payment.txid)).toBe(false)
    await accept(bob, payment, chain.chainTracker)
    expect(await spendableSats(bob)).toBe(50_000)
  })

  it('Bob pays Alice back from the unconfirmed sats', async () => {
    const before = await spendableSats(alice)
    const payment = await pay(bob, alice.identityKey, 20_000)
    await accept(alice, payment, chain.chainTracker)
    expect(await spendableSats(alice)).toBe(before + 20_000)
    expect(await spendableSats(bob)).toBeLessThan(30_000) // 30,000 minus the fee
  })

  it('rejects a payment worth less than claimed', async () => {
    const payment = await pay(alice, bob.identityKey, 1_000)
    await expect(accept(bob, { ...payment, satoshis: 5_000 }, chain.chainTracker)).rejects.toThrow(/not 5000/)
  })
})
