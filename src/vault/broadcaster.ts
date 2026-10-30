/**
 * Puts signed vault transactions on the network. Production uses Arcade
 * (guide §20: POST /tx with Extended Format); tests use the mock chain.
 */
import { Transaction } from '../shared/bsv.js'
import { arcadeUrl } from '../shared/network.js'

export interface Broadcaster {
  /** Throws if the network refused the transaction. */
  broadcast: (atomicBeef: number[], txid: string) => Promise<void>
}

const REFUSED = /REJECTED|INVALID|DOUBLE_SPEND/i

export class ArcadeBroadcaster implements Broadcaster {
  constructor (private readonly url = arcadeUrl()) {}

  async broadcast (atomicBeef: number[]): Promise<void> {
    // fromAtomicBEEF links each input to its source transaction, which EF needs.
    const ef = Transaction.fromAtomicBEEF(atomicBeef).toEF()
    const res = await fetch(`${this.url}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Uint8Array.from(ef),
      signal: AbortSignal.timeout(15_000)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Arcade refused the transaction (${res.status}): ${text.slice(0, 200)}`)
    let status = ''
    try { status = String((JSON.parse(text) as { txStatus?: string }).txStatus ?? '') } catch {}
    if (REFUSED.test(status)) throw new Error(`Arcade refused the transaction: ${status}`)
  }
}
