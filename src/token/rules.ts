/**
 * BSV-21 admission rules — a TypeScript port of 1Sat's validated topic manager
 * (b-open-io/1sat-stack pkg/bsv21/topic_validated.go).
 *
 * BSV-21 conservation is NOT enforced by Bitcoin Script (outputs are a plain
 * P2PKH with an inscription), so these rules are the whole truth:
 *
 *  - deploy+mint outputs are always admitted. Their token id is their own
 *    outpoint, so a deploy can never claim someone else's token.
 *  - transfer / burn outputs of a token are admitted only when the token
 *    inputs that the overlay ALREADY admitted (`previousCoins`) cover them.
 *  - a token input the overlay never admitted makes the whole transaction
 *    inadmissible: we cannot vouch for where it came from.
 *
 * The result is that every admitted UTXO descends, input by input, from the
 * genuine deploy.
 */
import type { Transaction } from '@bsv/sdk'
import { decodeBsv21, MAX_U64, tokenIdFromOutpoint } from './inscription'

export interface Admission {
  outputsToAdmit: number[]
  /** Token inputs consumed by this tx; the engine marks them spent and keeps them for history. */
  coinsToRetain: number[]
}

export class UnknownTokenInputError extends Error {
  constructor (readonly inputIndex: number, readonly outpoint: string) {
    super(`input ${inputIndex} spends token output ${outpoint}, which this overlay never admitted`)
  }
}

interface TokenSummary {
  tokensIn: bigint
  out: bigint
  vouts: number[]
}

export interface RuleOptions {
  /** If set, only these token ids are tracked (deploys of other tokens are ignored). */
  whitelist?: ReadonlySet<string>
}

export function identifyAdmissible (tx: Transaction, previousCoins: number[], opts: RuleOptions = {}): Admission {
  const txid = tx.id('hex')
  const tracked = (id: string): boolean => opts.whitelist === undefined || opts.whitelist.has(id)
  const admit: Admission = { outputsToAdmit: [], coinsToRetain: [] }
  const summary = new Map<string, TokenSummary>()

  // Pass 1: outputs.
  tx.outputs.forEach((output, vout) => {
    const d = decodeBsv21(output.lockingScript)
    if (d === null) return
    if (d.op === 'deploy+mint') {
      if (tracked(tokenIdFromOutpoint(txid, vout))) admit.outputsToAdmit.push(vout)
      return
    }
    const id = d.id!
    if (!tracked(id)) return
    const s = summary.get(id) ?? { tokensIn: 0n, out: 0n, vouts: [] }
    s.out += d.amount
    s.vouts.push(vout)
    summary.set(id, s)
  })
  if (summary.size === 0) return admit

  // Pass 2: inputs.
  tx.inputs.forEach((input, vin) => {
    const sourceTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (source === undefined || sourceTxid === undefined) return
    const d = decodeBsv21(source.lockingScript)
    if (d === null || d.op === 'burn') return // burned outputs carry no balance
    const id = d.op === 'deploy+mint' ? tokenIdFromOutpoint(sourceTxid, input.sourceOutputIndex) : d.id!
    const s = summary.get(id)
    if (s === undefined) return // incidental: this tx has no outputs of that token
    if (!previousCoins.includes(vin)) {
      throw new UnknownTokenInputError(vin, `${sourceTxid}_${input.sourceOutputIndex}`)
    }
    admit.coinsToRetain.push(vin)
    s.tokensIn += d.amount
  })

  // Per-token decision.
  for (const s of summary.values()) {
    if (s.out <= MAX_U64 && s.tokensIn >= s.out) admit.outputsToAdmit.push(...s.vouts)
  }
  admit.outputsToAdmit.sort((a, b) => a - b)
  admit.coinsToRetain.sort((a, b) => a - b)
  return admit
}
