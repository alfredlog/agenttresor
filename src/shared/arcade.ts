/**
 * Arcade (BSV Association infrastructure) clients.
 *
 * ArcadeChainTracker: a minimal SDK ChainTracker backed by Arcade's
 * go-chaintracks REST API (guide §20.3). Use it anywhere the SDK asks for a
 * chain tracker, e.g.
 * `await Transaction.fromAtomicBEEF(beef).verify(new ArcadeChainTracker())`.
 *
 *   GET {url}/chaintracks/v2/height                → { height }
 *   GET {url}/chaintracks/v2/header/height/{h}     → { merkleRoot, hash, … }
 *
 * Block headers never change once buried, so verified roots are cached.
 *
 * beefFromArcade: a BEEF for a transaction from GET {url}/tx/:txid.
 *
 * Both take a `fetch` so tests can serve them from the mock chain, offline.
 */
import { MerklePath, Transaction, type ChainTracker } from './bsv.js'
import { arcadeUrl } from './network.js'

export type FetchLike = (url: string) => Promise<Response>

export class ArcadeChainTracker implements ChainTracker {
  private readonly roots = new Map<number, string>()

  constructor (private readonly url = arcadeUrl(), private readonly fetchFn: FetchLike = async u => await fetch(u)) {}

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    let known = this.roots.get(height)
    if (known === undefined) {
      const res = await this.fetchFn(`${this.url}/chaintracks/v2/header/height/${height}`)
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`Arcade header request failed (${res.status})`)
      known = String((await res.json() as { merkleRoot: string }).merkleRoot).toLowerCase()
      this.roots.set(height, known)
    }
    return known === root.toLowerCase()
  }

  async currentHeight (): Promise<number> {
    const res = await this.fetchFn(`${this.url}/chaintracks/v2/height`)
    if (!res.ok) throw new Error(`Arcade height request failed (${res.status})`)
    return (await res.json() as { height: number }).height
  }
}

/**
 * Build a BEEF for `txid` from Arcade's GET /tx/:txid, which returns the raw
 * transaction (Extended Format) and, once mined, its merkle path. An unmined
 * transaction is completed by walking its parents until each is proven.
 */
export async function beefFromArcade (txid: string, url = arcadeUrl(), fetchFn: FetchLike = async u => await fetch(u)): Promise<number[]> {
  const seen = new Map<string, Transaction>()
  const load = async (id: string, depth: number): Promise<Transaction> => {
    const cached = seen.get(id)
    if (cached !== undefined) return cached
    if (depth > 25) throw new Error('unproven ancestry too deep')
    const res = await fetchFn(`${url}/tx/${id}`)
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
