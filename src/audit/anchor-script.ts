/**
 * The on-chain anchor of the audit log head (guide §12, OP_RETURN):
 *
 *   OP_FALSE OP_RETURN "agenttresor-audit" <hash, 32 bytes> <seq as UTF-8>
 *
 * A provably unspendable 0-sat output, created and paid by the company's own
 * wallet. Shared by the browser (to build it) and the proxy (to check it).
 */
import { LockingScript, OP, Script, Utils } from '../shared/bsv.js'

export const ANCHOR_TAG = 'agenttresor-audit'

export function anchorLockingScript (hashHex: string, seq: number): LockingScript {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error('hash must be 32 bytes of hex')
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('seq must be a positive integer')
  return new LockingScript()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(ANCHOR_TAG, 'utf8'))
    .writeBin(Utils.toArray(hashHex, 'hex'))
    .writeBin(Utils.toArray(String(seq), 'utf8')) as LockingScript
}

/** The anchored {seq, hash}, or undefined if the script is not exactly an AgentTresor anchor. */
export function parseAnchorScript (script: Script | string): { seq: number, hash: string } | undefined {
  const bin = (typeof script === 'string' ? Script.fromHex(script) : script).toBinary()
  // Check the OP_FALSE OP_RETURN prefix on the raw bytes: parsers may fold what follows OP_RETURN into one chunk.
  if (bin.length < 2 || bin[0] !== OP.OP_FALSE || bin[1] !== OP.OP_RETURN) return undefined
  let chunks
  try { chunks = Script.fromBinary(bin.slice(2)).chunks } catch { return undefined }
  if (chunks.length !== 3 || chunks.some(c => c.data === undefined)) return undefined
  const [tag, hash, seq] = chunks.map(c => c.data!)
  if (Utils.toUTF8(tag) !== ANCHOR_TAG || hash.length !== 32) return undefined
  const seqText = Utils.toUTF8(seq)
  if (!/^[1-9][0-9]{0,15}$/.test(seqText)) return undefined
  // Only the canonical encoding counts, so one anchor has exactly one byte form.
  const parsed = { seq: Number(seqText), hash: Utils.toHex(hash) }
  return anchorLockingScript(parsed.hash, parsed.seq).toHex() === Utils.toHex(bin) ? parsed : undefined
}
