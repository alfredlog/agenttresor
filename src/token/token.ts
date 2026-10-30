/**
 * TokenKit — BSV-21 tokens on any BRC-100 wallet (BSV Desktop, wallet-toolbox…).
 *
 * The overlay is the source of truth: it validates every token UTXO back to
 * its deploy. The wallet basket `bsv21` is the owner's local copy: `sync()`
 * pulls what the overlay says you own into the basket, and `send()` spends
 * from the basket, so the wallet tracks spends and backs the tokens up.
 * Based on the official bsv21-token-kit starter kit from the BSV Developer Pack.
 */
import { Beef, Transaction, type WalletInterface } from '../shared/bsv.js'
import { buildBsv21Script, decodeBsv21, tokenIdFromOutpoint, type DecodedBsv21 } from './inscription'
import { instructionsFor, receivePkh, TOKEN_BASKET, type CustomInstructions } from './addresses'
import type { OverlayClient, OverlayOutput } from './overlayApi'
import { P2PKH_UNLOCK_LENGTH, signWalletP2pkhInput } from './signer'
import { selectUtxos } from './coinselect'

export interface BasketEntry {
  outpoint: string
  txid: string
  vout: number
  decoded: DecodedBsv21
  tokenId: string
  instructions: CustomInstructions
}

export interface TokenUtxo {
  txid: string
  vout: number
  outpoint: string
  tokenId: string
  amount: bigint
  /** Receive-key index of the owner's address. */
  index: number
  sym?: string
  dec?: string
  inBasket: boolean
  inOverlay: boolean
}

export interface TokenBalance {
  tokenId: string
  sym?: string
  dec: string
  overlay: bigint
  basket: bigint
  utxos: number
}

const tokenIdOf = (d: DecodedBsv21, txid: string, vout: number): string =>
  d.op === 'deploy+mint' ? tokenIdFromOutpoint(txid, vout) : d.id!

export class TokenKit {
  private identity?: string

  constructor (
    readonly wallet: WalletInterface,
    readonly overlay: OverlayClient,
    readonly originator?: string
  ) {}

  async identityKey (): Promise<string> {
    this.identity ??= (await this.wallet.getPublicKey({ identityKey: true }, this.originator)).publicKey
    return this.identity
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** What the overlay says `identityKey` holds (works for anyone's identity key). */
  async overlayUtxos (identityKey: string, tokenId?: string): Promise<OverlayOutput[]> {
    return await this.overlay.lookup({ op: 'identity', identityKey, tokenId })
  }

  /** The owner's token UTXOs in the wallet basket. */
  async basketEntries (): Promise<{ entries: BasketEntry[], beef: number[] }> {
    const res = await this.wallet.listOutputs({
      basket: TOKEN_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 1000
    }, this.originator)
    const beef = res.BEEF !== undefined ? Array.from(res.BEEF) : []
    const parsed = beef.length > 0 ? Beef.fromBinary(beef) : undefined
    const entries: BasketEntry[] = []
    for (const o of res.outputs) {
      const [txid, voutStr] = o.outpoint.split('.')
      const vout = Number(voutStr)
      const tx = parsed?.findTxid(txid)?.tx
      const script = o.lockingScript ?? tx?.outputs[vout]?.lockingScript.toHex()
      if (script === undefined) continue
      const decoded = decodeBsv21(script)
      if (decoded === null || o.customInstructions === undefined) continue
      entries.push({
        outpoint: o.outpoint,
        txid,
        vout,
        decoded,
        tokenId: tokenIdOf(decoded, txid, vout),
        instructions: JSON.parse(o.customInstructions) as CustomInstructions
      })
    }
    return { entries, beef }
  }

  /** Merged view: every UTXO the overlay or the basket knows about. */
  async utxos (tokenId?: string): Promise<TokenUtxo[]> {
    const me = await this.identityKey()
    const [fromOverlay, { entries }] = await Promise.all([this.overlayUtxos(me, tokenId), this.basketEntries()])
    const byOutpoint = new Map<string, TokenUtxo>()
    for (const o of fromOverlay) {
      const outpoint = `${o.txid}.${o.vout}`
      byOutpoint.set(outpoint, {
        txid: o.txid,
        vout: o.vout,
        outpoint,
        tokenId: o.ctx.tokenId,
        amount: BigInt(o.ctx.amt),
        index: o.ctx.index ?? -1,
        sym: o.ctx.sym,
        dec: o.ctx.dec,
        inBasket: false,
        inOverlay: true
      })
    }
    for (const e of entries) {
      if (tokenId !== undefined && e.tokenId !== tokenId) continue
      const known = byOutpoint.get(e.outpoint)
      if (known !== undefined) { known.inBasket = true; continue }
      byOutpoint.set(e.outpoint, {
        txid: e.txid,
        vout: e.vout,
        outpoint: e.outpoint,
        tokenId: e.tokenId,
        amount: e.decoded.amount,
        index: e.instructions.index ?? -1,
        sym: e.decoded.sym,
        dec: e.decoded.dec,
        inBasket: true,
        inOverlay: false
      })
    }
    return [...byOutpoint.values()]
  }

  async balances (): Promise<TokenBalance[]> {
    const map = new Map<string, TokenBalance>()
    for (const u of await this.utxos()) {
      const b = map.get(u.tokenId) ?? { tokenId: u.tokenId, sym: u.sym, dec: u.dec ?? '0', overlay: 0n, basket: 0n, utxos: 0 }
      if (u.inOverlay) b.overlay += u.amount
      if (u.inBasket) b.basket += u.amount
      b.sym ??= u.sym
      b.utxos++
      map.set(u.tokenId, b)
    }
    return [...map.values()]
  }

  /** Next unused receive index of `identityKey` according to the overlay (and our basket, for ourselves). */
  async nextIndex (identityKey: string): Promise<number> {
    const seen = await this.overlay.lookup({ op: 'identity', identityKey, includeSpent: true })
    let max = Math.max(-1, ...seen.map(o => o.ctx.index ?? -1))
    if (identityKey === await this.identityKey()) {
      const { entries } = await this.basketEntries()
      max = Math.max(max, ...entries.map(e => e.instructions.index ?? -1))
    }
    return max + 1
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  async deploy (args: { sym: string, amt: bigint, dec: number, icon?: string }): Promise<{ txid: string, tokenId: string }> {
    const me = await this.identityKey()
    const index = await this.nextIndex(me)
    const lockingScript = buildBsv21Script(
      { op: 'deploy+mint', amt: args.amt.toString(), sym: args.sym, dec: String(args.dec), icon: args.icon },
      receivePkh(me, index)
    )
    const res = await this.wallet.createAction({
      description: `Deploy BSV-21 token ${args.sym}`.slice(0, 50),
      labels: ['bsv21'],
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: `${args.sym} supply`.slice(0, 50),
        basket: TOKEN_BASKET,
        customInstructions: JSON.stringify(instructionsFor(index)),
        tags: ['bsv21', `amt:${args.amt}`]
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.txid === undefined || res.tx === undefined) throw new Error('deploy was not completed by the wallet')
        const deployedTx = Transaction.fromAtomicBEEF(res.tx)
    const expectedScript = lockingScript.toHex()
    const matchingVouts = deployedTx.outputs.flatMap((output, vout) =>
      output.lockingScript.toHex() === expectedScript ? [vout] : []
    )
    if (matchingVouts.length !== 1) throw new Error('could not uniquely locate BSV-21 deployment output')

    await this.overlay.submit(res.tx)
    return { txid: res.txid, tokenId: tokenIdFromOutpoint(res.txid, matchingVouts[0]) }
  }

  /**
   * Overlay ↔ basket.
   *  1. Retries queued overlay submissions.
   *  2. Heals: basket token UTXOs the overlay has never seen are re-submitted
   *     from chain (WhatsOnChain BEEF). Genuine ones get admitted; forgeries
   *     stay "unvalidated" and are never spent.
   *  3. Inserts into the basket the UTXOs the overlay credits to us.
   *  4. Relinquishes basket entries the overlay reports as spent.
   */
  async sync (): Promise<{ inserted: string[], relinquished: string[], healed: string[], unvalidated: string[] }> {
    await this.overlay.flush()
    const me = await this.identityKey()
    let [fromOverlay, { entries }] = await Promise.all([
      this.overlay.lookup({ op: 'identity', identityKey: me, includeSpent: true }),
      this.basketEntries()
    ])

    const healed: string[] = []
    const unvalidated: string[] = []
    const known = new Set(fromOverlay.map(o => `${o.txid}.${o.vout}`))
    const pending = new Set(this.overlay.pending().map(i => i.txid))
    const unknownTxids = [...new Set(entries.filter(e => !known.has(e.outpoint) && !pending.has(e.txid)).map(e => e.txid))]
    for (const txid of unknownTxids) {
      try {
        await this.overlay.submitFromChain(txid)
        healed.push(txid)
      } catch {
        unvalidated.push(...entries.filter(e => e.txid === txid).map(e => e.outpoint))
      }
    }
    if (healed.length > 0) fromOverlay = await this.overlay.lookup({ op: 'identity', identityKey: me, includeSpent: true })

    const inBasket = new Set(entries.map(e => e.outpoint))
    const inserted: string[] = []
    const relinquished: string[] = []

    const missingByTx = new Map<string, OverlayOutput[]>()
    for (const o of fromOverlay) {
      if (o.ctx.spent || inBasket.has(`${o.txid}.${o.vout}`) || o.ctx.index === undefined) continue
      missingByTx.set(o.txid, [...(missingByTx.get(o.txid) ?? []), o])
    }
    for (const [txid, outs] of missingByTx) {
      await this.wallet.internalizeAction({
        tx: Transaction.fromBEEF(outs[0].beef, txid).toAtomicBEEF(),
        outputs: outs.map(o => ({
          outputIndex: o.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: TOKEN_BASKET,
            customInstructions: JSON.stringify(instructionsFor(o.ctx.index!)),
            tags: ['bsv21', `id:${o.ctx.tokenId}`, `amt:${o.ctx.amt}`]
          }
        })),
        labels: ['bsv21'],
        description: 'Receive BSV-21 tokens'
      }, this.originator)
      inserted.push(...outs.map(o => `${o.txid}.${o.vout}`))
    }

    const spentOnOverlay = new Set(fromOverlay.filter(o => o.ctx.spent).map(o => `${o.txid}.${o.vout}`))
    for (const e of entries) {
      if (!spentOnOverlay.has(e.outpoint)) continue
      await this.wallet.relinquishOutput({ basket: TOKEN_BASKET, output: e.outpoint }, this.originator)
      relinquished.push(e.outpoint)
    }
    return { inserted, relinquished, healed, unvalidated }
  }

  /** Send `amount` of `tokenId` to an identity key (or to yourself, on a fresh address). */
  async send (tokenId: string, amount: bigint, to: string | 'self'): Promise<{ txid: string, recipientIndex: number }> {
    if (amount <= 0n) throw new Error('amount must be positive')
    const { entries, beef } = await this.spendable(tokenId)
    const { selected, total } = selectUtxos(entries, amount)
    return await this.spendInputs(selected, beef, tokenId, [
      { to, amount },
      ...(total > amount ? [{ to: 'self' as const, amount: total - amount }] : [])
    ], `Send ${amount} tokens`)
  }

  /** Consolidate every UTXO of `tokenId` into one, on a fresh address of yours. */
  async merge (tokenId: string): Promise<{ txid: string, recipientIndex: number }> {
    const { entries: selected, beef } = await this.spendable(tokenId)
    if (selected.length < 2) throw new Error('nothing to merge: fewer than two UTXOs')
    const total = selected.reduce((s, u) => s + u.amount, 0n)
    return await this.spendInputs(selected, beef, tokenId, [{ to: 'self', amount: total }], `Merge ${selected.length} token UTXOs`)
  }

  /**
   * Basket UTXOs of `tokenId` that the overlay has validated and not seen spent.
   * A basket entry the overlay does not vouch for (a forgery dropped into the
   * basket, or a transaction still waiting to be submitted) is never spent:
   * mixing it with genuine inputs would get the whole transaction rejected.
   */
  async spendable (tokenId: string): Promise<{ entries: Array<BasketEntry & { amount: bigint }>, beef: number[] }> {
    const me = await this.identityKey()
    const [validated, { entries, beef }] = await Promise.all([this.overlayUtxos(me, tokenId), this.basketEntries()])
    const ok = new Set(validated.map(o => `${o.txid}.${o.vout}`))
    // The overlay keeps each UTXO's full ancestry back to mined transactions;
    // the wallet's listOutputs BEEF may omit unmined parents, which a strict
    // broadcaster rejects. Use the overlay's BEEF, topped up with the wallet's.
    const merged = new Beef()
    for (const o of validated) merged.mergeBeef(o.beef)
    if (beef.length > 0) merged.mergeBeef(beef)
    return {
      entries: entries.filter(e => e.tokenId === tokenId && ok.has(e.outpoint)).map(e => ({ ...e, amount: e.decoded.amount })),
      beef: merged.toBinary()
    }
  }

  /** Low-level spend of the given basket entries. Does NOT check them against the overlay — prefer send/merge. */
  async spendInputs (
    inputs: Array<BasketEntry & { amount: bigint }>,
    inputBEEF: number[],
    tokenId: string,
    destinations: Array<{ to: string | 'self', amount: bigint }>,
    description: string
  ): Promise<{ txid: string, recipientIndex: number }> {
    const me = await this.identityKey()
    let nextOwn = await this.nextIndex(me)
    const outputs = []
    let recipientIndex = -1
    for (const d of destinations) {
      const self = d.to === 'self' || d.to === me
      const owner = self ? me : d.to
      const index = self ? nextOwn++ : await this.nextIndex(owner)
      if (recipientIndex === -1) recipientIndex = index
      outputs.push({
        lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: d.amount.toString() }, receivePkh(owner, index)).toHex(),
        satoshis: 1,
        outputDescription: self ? 'Tokens to self' : 'Tokens to recipient',
        ...(self
          ? { basket: TOKEN_BASKET, customInstructions: JSON.stringify(instructionsFor(index)), tags: ['bsv21', `id:${tokenId}`, `amt:${d.amount}`] }
          : {})
      })
    }

    const created = await this.wallet.createAction({
      description: description.slice(0, 50),
      labels: ['bsv21'],
      inputBEEF,
      inputs: inputs.map(u => ({ outpoint: u.outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: 'BSV-21 token input' })),
      outputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')

    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (const u of inputs) {
      const i = tx.inputs.findIndex(inp => (inp.sourceTXID ?? inp.sourceTransaction?.id('hex')) === u.txid && inp.sourceOutputIndex === u.vout)
      if (i === -1) throw new Error(`token input ${u.outpoint} missing from signable transaction`)
      if (tx.inputs[i].sourceTransaction === undefined) {
        tx.inputs[i].sourceTransaction = Beef.fromBinary(inputBEEF).findTxid(u.txid)?.tx
      }
      const key = { protocolID: u.instructions.protocolID, keyID: u.instructions.keyID }
      spends[i] = { unlockingScript: (await signWalletP2pkhInput(this.wallet, tx, i, key, this.originator)).toHex() }
    }
    const signed = await this.wallet.signAction({ reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.txid === undefined || signed.tx === undefined) throw new Error('wallet did not complete the transaction')
    await this.overlay.submit(signed.tx)
    return { txid: signed.txid, recipientIndex }
  }
}
