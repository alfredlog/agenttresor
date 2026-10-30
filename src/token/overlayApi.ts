/**
 * Minimal client for the kit overlay: standard POST /submit and POST /lookup,
 * plus an outbox so token transactions reach the overlay in order.
 *
 * The overlay only admits a transfer whose token inputs it already knows, and
 * it does not fetch missing parents itself, so a failed submit must be retried
 * before any child transaction is submitted.
 */
import { Beef, MerklePath, Transaction, Utils } from '@bsv/sdk'
import type { KitQuery, OutputContext } from './overlay/Bsv21KitLookupService'
import { decodeBsv21 } from './inscription'

export const TOPIC = 'tm_tokenkit'
export const SERVICE = 'ls_tokenkit'

export interface OverlayOutput {
  txid: string
  vout: number
  tx: Transaction
  /** BEEF (as returned by the overlay) containing tx and its ancestry. */
  beef: number[]
  ctx: OutputContext
}

export interface OutboxItem {
  txid: string
  beef: number[]
  attempts?: number
  lastError?: string
}

export interface OutboxStore {
  load: () => OutboxItem[]
  save: (items: OutboxItem[]) => void
}

export const memoryOutbox = (): OutboxStore => {
  let items: OutboxItem[] = []
  return { load: () => items, save: (next) => { items = next } }
}

export const DEFAULT_ARCADE_URL = 'https://arcade-v2-us-1.bsvblockchain.tech'

/**
 * Build a BEEF for `txid` from Arcade's GET /tx/:txid, which returns the raw
 * transaction (Extended Format) and, once mined, its merkle path. An unmined
 * transaction is completed by walking its parents until each is proven.
 */
export async function beefFromArcade (txid: string, arcadeUrl = DEFAULT_ARCADE_URL): Promise<number[]> {
  const seen = new Map<string, Transaction>()
  const load = async (id: string, depth: number): Promise<Transaction> => {
    const cached = seen.get(id)
    if (cached !== undefined) return cached
    if (depth > 25) throw new Error('unproven ancestry too deep')
    const res = await fetch(`${arcadeUrl}/tx/${id}`)
    if (!res.ok) throw new Error(`Arcade does not know ${id} (${res.status})`)
    const info = await res.json() as { rawTx?: string, merklePath?: string }
    if (info.rawTx === undefined || info.rawTx === '') throw new Error(`Arcade has no raw tx for ${id}`)
    // Extended Format = version (4 bytes) followed by the marker 0000000000EF.
    const isEF = info.rawTx.slice(8, 20).toLowerCase() === '0000000000ef'
    const tx = isEF ? Transaction.fromHexEF(info.rawTx) : Transaction.fromHex(info.rawTx)
    seen.set(id, tx)
    if (info.merklePath !== undefined && info.merklePath !== '') {
      tx.merklePath = MerklePath.fromHex(info.merklePath)
    } else {
      for (const input of tx.inputs) {
        input.sourceTransaction = await load(input.sourceTXID ?? input.sourceTransaction!.id('hex'), depth + 1)
      }
    }
    return tx
  }
  return (await load(txid, 0)).toBEEF()
}

/** Transient overlay errors (e.g. its chain tracker rate-limited) are retried this many times. */
const MAX_ATTEMPTS = 5

export class OverlayClient {
  constructor (
    readonly url: string,
    private readonly outbox: OutboxStore = memoryOutbox(),
    readonly chain: 'main' | 'test' = 'main',
    readonly arcadeUrl = DEFAULT_ARCADE_URL
  ) {}

  /** Queue a transaction (BEEF or AtomicBEEF) and flush the queue in order. */
  async submit (tx: number[] | Uint8Array): Promise<Record<string, unknown>> {
    const bytes = Array.from(tx)
    const parsed = Beef.fromBinary(bytes)
    const txid = parsed.atomicTxid ?? parsed.txs[parsed.txs.length - 1].txid
    const beef = Transaction.fromBEEF(bytes, txid).toBEEF()
    this.outbox.save([...this.outbox.load().filter(i => i.txid !== txid), { txid, beef }])
    const results = await this.flush()
    const mine = results.find(r => r.txid === txid)
    if (mine === undefined) {
      const queued = this.outbox.load().find(i => i.txid === txid)
      throw new Error(`transaction ${txid} is on chain but not yet in the overlay` +
        (queued?.lastError !== undefined ? ` (${queued.lastError})` : ' (an earlier transaction is still queued)') +
        '; it will be retried on the next sync')
    }
    if (mine.error !== undefined) throw new Error(mine.error)
    return mine.steak!
  }

  /**
   * Re-submit a transaction that is already on chain. Recovers tokens whose
   * original submit never reached the overlay. The BEEF (tx + ancestry back to
   * merkle proofs) comes from Arcade, falling back to WhatsOnChain.
   */
  async submitFromChain (txid: string): Promise<Record<string, unknown>> {
    let beef: number[]
    try {
      beef = await beefFromArcade(txid, this.arcadeUrl)
    } catch {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.chain}/tx/${txid}/beef`)
      if (!res.ok) throw new Error(`neither Arcade nor WhatsOnChain could provide ${txid} (${res.status})`)
      beef = Utils.toArray((await res.text()).trim(), 'hex')
    }
    return await this.submit(beef)
  }

  /** Submit queued transactions in order; stop at the first one the overlay cannot take yet. */
  async flush (): Promise<Array<{ txid: string, steak?: Record<string, unknown>, error?: string }>> {
    const queue = this.outbox.load().map(i => ({ ...i }))
    const done: Array<{ txid: string, steak?: Record<string, unknown>, error?: string }> = []
    while (queue.length > 0) {
      const item = queue[0]
      let res: Response
      try {
        res = await fetch(`${this.url}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Topics': JSON.stringify([TOPIC]) },
          body: new Uint8Array(item.beef)
        })
      } catch {
        break // overlay unreachable: keep the queue and retry later
      }
      const body = await res.json().catch(() => ({})) as Record<string, any>
      if (!res.ok) {
        // The engine answers a generic error when SPV checking fails for
        // infrastructure reasons (e.g. its chain tracker was rate-limited):
        // keep the item and retry later, a bounded number of times.
        item.attempts = (item.attempts ?? 0) + 1
        item.lastError = `overlay answered ${res.status}: ${String(body.message ?? body.description ?? res.statusText)}`
        if (item.attempts < MAX_ATTEMPTS) break
        queue.shift()
        done.push({ txid: item.txid, error: `overlay rejected ${item.txid} after ${item.attempts} attempts: ${item.lastError}` })
        continue
      }
      queue.shift()
      {
        const missing = await this.unadmittedTokenOutputs(item, body)
        if (missing.length > 0) {
          // Earlier queue items were already submitted, so this is not a parent
          // still pending: the transaction does not descend from a genuine deploy.
          done.push({ txid: item.txid, error: `overlay did not admit token output(s) ${missing.join(', ')} of ${item.txid}: they do not descend from the token's deploy (or spend a token output the overlay never admitted)` })
        } else {
          done.push({ txid: item.txid, steak: body })
        }
      }
    }
    this.outbox.save(queue)
    return done
  }

  /**
   * Token outputs of the submitted transaction that the overlay did not admit.
   * The STEAK alone cannot tell a refusal from a duplicate submission (both
   * admit nothing), so anything not in the STEAK is checked with a lookup.
   */
  private async unadmittedTokenOutputs (item: OutboxItem, steak: Record<string, any>): Promise<number[]> {
    const tx = Transaction.fromBEEF(item.beef, item.txid)
    const tokenVouts = tx.outputs.map((o, vout) => (decodeBsv21(o.lockingScript) !== null ? vout : -1)).filter(v => v >= 0)
    const admitted = new Set<number>(steak[TOPIC]?.outputsToAdmit ?? [])
    const missing: number[] = []
    for (const vout of tokenVouts) {
      if (admitted.has(vout)) continue
      if ((await this.lookup({ op: 'outpoint', txid: item.txid, vout })).length === 0) missing.push(vout)
    }
    return missing
  }

  pending (): OutboxItem[] {
    return this.outbox.load()
  }

  async lookup (query: KitQuery): Promise<OverlayOutput[]> {
    const res = await fetch(`${this.url}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: SERVICE, query })
    })
    const answer = await res.json() as any
    if (!res.ok) throw new Error(`lookup failed: ${String(answer.message ?? res.statusText)}`)
    if (answer.type !== 'output-list') throw new Error(`unexpected lookup answer ${String(answer.type)}`)
    return answer.outputs.map((o: { beef: number[], outputIndex: number, context?: number[] }) => {
      const tx = Transaction.fromBEEF(o.beef)
      return {
        txid: tx.id('hex'),
        vout: o.outputIndex,
        tx,
        beef: o.beef,
        ctx: JSON.parse(Utils.toUTF8(o.context ?? [])) as OutputContext
      }
    })
  }
}
