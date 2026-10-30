/**
 * WhatsOnChain chain tracker that survives the free API's rate limit.
 *
 * Every submit verifies the merkle root of each proven ancestor in the BEEF.
 * Without an API key WhatsOnChain answers ~3 requests/s and returns 429 beyond
 * that; the SDK's tracker turns any failed request into "Failed to verify
 * merkleroot", which rejects a perfectly valid transaction. This wrapper:
 *  - caches confirmed (height, root) pairs — block headers do not change;
 *  - runs one request at a time;
 *  - retries failed requests with exponential backoff.
 * Set WOC_API_KEY for higher limits.
 */
import { WhatsOnChain, type ChainTracker } from '../../shared/bsv.js'

export class ResilientChainTracker implements ChainTracker {
  private readonly inner: WhatsOnChain
  private readonly verified = new Map<number, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private height?: { value: number, at: number }

  constructor (network: 'main' | 'test' = 'main', apiKey?: string, private readonly retries = 6) {
    this.inner = new WhatsOnChain(network, apiKey !== undefined && apiKey !== '' ? { apiKey } : {})
  }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    if (this.verified.get(height) === root) return true
    const ok = await this.serial(async () => await this.inner.isValidRootForHeight(root, height))
    if (ok) this.verified.set(height, root)
    return ok
  }

  async currentHeight (): Promise<number> {
    if (this.height !== undefined && Date.now() - this.height.at < 30_000) return this.height.value
    const value = await this.serial(async () => await this.inner.currentHeight())
    this.height = { value, at: Date.now() }
    return value
  }

  /** One request at a time, retried with backoff (0.4s, 0.8s, 1.6s …). */
  private async serial<T> (fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn()
        } catch (e) {
          if (attempt >= this.retries) throw e
          await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt))
        }
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return await next
  }
}
