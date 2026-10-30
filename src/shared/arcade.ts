/**
 * Minimal SDK ChainTracker backed by Arcade's go-chaintracks REST API (guide §20.3).
 * Use it anywhere the SDK asks for a chain tracker, e.g.
 * `await Transaction.fromAtomicBEEF(beef).verify(new ArcadeChainTracker())`.
 *
 *   GET {url}/chaintracks/v2/height                → { height }
 *   GET {url}/chaintracks/v2/header/height/{h}     → { merkleRoot, hash, … }
 *
 * Block headers never change once buried, so verified roots are cached.
 */
import type { ChainTracker } from '@bsv/sdk'
import { arcadeUrl } from './network.js'

export class ArcadeChainTracker implements ChainTracker {
  private readonly roots = new Map<number, string>()

  constructor (private readonly url = arcadeUrl()) {}

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    let known = this.roots.get(height)
    if (known === undefined) {
      const res = await fetch(`${this.url}/chaintracks/v2/header/height/${height}`)
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`Arcade header request failed (${res.status})`)
      known = String((await res.json() as { merkleRoot: string }).merkleRoot).toLowerCase()
      this.roots.set(height, known)
    }
    return known === root.toLowerCase()
  }

  async currentHeight (): Promise<number> {
    const res = await fetch(`${this.url}/chaintracks/v2/height`)
    if (!res.ok) throw new Error(`Arcade height request failed (${res.status})`)
    return (await res.json() as { height: number }).height
  }
}
