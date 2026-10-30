/**
 * Tokens, end to end, offline: real wallet-toolbox wallets (the same wallet
 * engine BSV Desktop runs) on wallet-toolbox's mock chain, and the real overlay
 * server over HTTP, with SPV checked against the mock chain's headers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { startOverlay, type RunningOverlay } from '../src/token/overlay/server'
import { OverlayClient } from '../src/token/overlayApi'
import { TokenKit } from '../src/token/token'
import { buildBsv21Script } from '../src/token/inscription'
import { instructionsFor, receivePkh, TOKEN_BASKET } from '../src/token/addresses'
import { createMockChain, type MockChain } from './helpers/token-mockchain'

let chain: MockChain
let overlay: RunningOverlay
const makeWallet = async (rootKey?: PrivateKey): Promise<Wallet> => await chain.makeWallet(rootKey)
const fund = async (wallet: Wallet): Promise<void> => await chain.fund(wallet)

const sum = (xs: Array<{ amount: bigint }>): bigint => xs.reduce((s, x) => s + x.amount, 0n)
const unspentAmounts = async (kit: TokenKit, identityKey: string, tokenId: string): Promise<bigint[]> =>
  (await kit.overlayUtxos(identityKey, tokenId)).map(o => BigInt(o.ctx.amt)).sort((a, b) => (a < b ? -1 : 1))

beforeAll(async () => {
  chain = await createMockChain()
  const dir = mkdtempSync(join(tmpdir(), 'bsv21kit-'))
  overlay = await startOverlay({ port: 18090, dbFile: join(dir, 'overlay.db'), chainTracker: chain.chainTracker, quiet: true })
})

afterAll(async () => {
  await overlay?.close()
  await chain?.close()
})

describe('BSV-21 token kit, end to end', () => {
  let alice: Wallet, bob: Wallet
  let kitA: TokenKit, kitB: TokenKit
  let aliceKey: string, bobKey: string
  let tokenId: string

  it('sets up two funded BRC-100 wallets', async () => {
    alice = await makeWallet()
    bob = await makeWallet()
    await fund(alice)
    await fund(bob)
    kitA = new TokenKit(alice, new OverlayClient(overlay.url))
    kitB = new TokenKit(bob, new OverlayClient(overlay.url))
    aliceKey = await kitA.identityKey()
    bobKey = await kitB.identityKey()
  })

  it('deploys a token: overlay and basket agree', async () => {
    ;({ tokenId } = await kitA.deploy({ sym: 'KIT', amt: 1_000_000n, dec: 2 }))
    expect(tokenId).toMatch(/^[0-9a-f]{64}_\d+$/)
    const [b] = await kitA.balances()
    expect(b).toMatchObject({ tokenId, sym: 'KIT', overlay: 1_000_000n, basket: 1_000_000n, utxos: 1 })
  })

  it('sends to another identity key; the recipient sees it via the overlay without being told', async () => {
    await kitA.send(tokenId, 300n, bobKey)
    expect(await unspentAmounts(kitA, bobKey, tokenId)).toEqual([300n]) // queried by Alice, Bob did nothing
    let [b] = await kitB.balances()
    expect(b).toMatchObject({ overlay: 300n, basket: 0n }) // overlay knows, Bob's wallet does not yet
    const { inserted } = await kitB.sync()
    expect(inserted).toHaveLength(1)
    ;[b] = await kitB.balances()
    expect(b).toMatchObject({ overlay: 300n, basket: 300n })
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([999_700n]) // change on a fresh address
  })

  it('merges two UTXOs into one (and the overlay accepts it)', async () => {
    await kitA.send(tokenId, 200n, bobKey)
    await kitB.sync()
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([200n, 300n])
    await kitB.merge(tokenId)
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([500n])
    const utxos = await kitB.utxos(tokenId)
    expect(utxos).toHaveLength(1)
    expect(utxos[0]).toMatchObject({ amount: 500n, inBasket: true, inOverlay: true })
  })

  it('selects several UTXOs to cover an amount and returns change', async () => {
    await kitA.send(tokenId, 1_000n, 'self') // Alice now holds 998_500 + 1_000 (+ earlier history)
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([1_000n, 998_500n])
    await kitA.send(tokenId, 999_000n, bobKey) // needs both UTXOs
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([500n])
    await kitB.sync()
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([500n, 999_000n])
  })

  it('supply is conserved across every transfer', async () => {
    const all = [...await kitA.overlayUtxos(aliceKey, tokenId), ...await kitA.overlayUtxos(bobKey, tokenId)]
    expect(sum(all.map(o => ({ amount: BigInt(o.ctx.amt) })))).toBe(1_000_000n)
  })

  it('FORGERY: a "transfer" of the real token created from plain sats is not admitted', async () => {
    const forgedScript = buildBsv21Script({ op: 'transfer', id: tokenId, amt: '5000000' }, receivePkh(bobKey, 50))
    const res = await bob.createAction({
      description: 'Forged token output',
      outputs: [{ lockingScript: forgedScript.toHex(), satoshis: 1, outputDescription: 'forged tokens' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    // It broadcasts fine on-chain (Script does not enforce BSV-21), but the overlay refuses it.
    await expect(kitB.overlay.submit(res.tx!)).rejects.toThrow(/did not admit/)
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([500n, 999_000n])
  })

  it('FORGERY: a fake token UTXO dropped into the basket is never selected, and spending it is rejected', async () => {
    // A wallet basket does not validate tokens: anyone's app can insert a fake.
    const fakeIndex = 60
    const res = await bob.createAction({
      description: 'Fake token in basket',
      outputs: [{
        lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '7000000' }, receivePkh(bobKey, fakeIndex)).toHex(),
        satoshis: 1,
        outputDescription: 'fake tokens',
        basket: TOKEN_BASKET,
        customInstructions: JSON.stringify(instructionsFor(fakeIndex))
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const fakeOutpoint = `${res.txid!}.0`
    const utxos = await kitB.utxos(tokenId)
    expect(utxos.find(u => u.outpoint === fakeOutpoint)).toMatchObject({ inBasket: true, inOverlay: false })
    const [b] = (await kitB.balances()).filter(x => x.tokenId === tokenId)
    expect(b.overlay).toBe(999_500n) // the overlay view ignores the fake
    expect((await kitB.spendable(tokenId)).entries.map(e => e.outpoint)).not.toContain(fakeOutpoint)

    // Bypass the kit's protection and spend the fake directly: the overlay refuses it.
    const { entries } = await kitB.basketEntries()
    const fake = entries.find(e => e.outpoint === fakeOutpoint)!
    await expect(kitB.spendInputs([{ ...fake, amount: fake.decoded.amount }], Array.from(res.tx!), tokenId, [{ to: aliceKey, amount: 7_000_000n }], 'Spend fake tokens'))
      .rejects.toThrow(/did not admit/)
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([500n]) // Alice got nothing
  })

  it('a spent UTXO disappears from the overlay', async () => {
    const before = await kitB.overlayUtxos(bobKey, tokenId)
    const { txid } = await kitB.send(tokenId, 100n, aliceKey)
    const after = new Set((await kitB.overlayUtxos(bobKey, tokenId)).map(o => `${o.txid}.${o.vout}`))
    const gone = before.filter(o => !after.has(`${o.txid}.${o.vout}`))
    expect(gone).toHaveLength(1) // exactly the selected input left the unspent set
    const history = await kitB.overlay.lookup({ op: 'identity', identityKey: bobKey, tokenId, includeSpent: true })
    const spent = history.find(o => o.txid === gone[0].txid && o.vout === gone[0].vout)!
    expect(spent.ctx).toMatchObject({ spent: true, spendingTxid: txid }) // kept as history, marked spent
  })

  it('RECOVERY: a fresh wallet with the same key and no local data recovers its tokens from the overlay', async () => {
    const restored = await makeWallet(PrivateKey.fromHex((bob as any).keyDeriver.rootKey.toHex()))
    await fund(restored) // fresh storage knows nothing; sats only to pay for a later send
    const kitR = new TokenKit(restored, new OverlayClient(overlay.url))
    expect(await kitR.identityKey()).toBe(bobKey)
    const { inserted } = await kitR.sync()
    expect(inserted.length).toBeGreaterThan(0)
    const [b] = (await kitR.balances()).filter(x => x.tokenId === tokenId)
    expect(b.basket).toBe(b.overlay)
    expect(b.overlay).toBe(999_400n)
    await kitR.send(tokenId, 400n, aliceKey) // the restored wallet can spend them
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([100n, 400n, 500n])
  })
})
