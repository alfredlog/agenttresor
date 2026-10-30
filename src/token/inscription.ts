/**
 * 1Sat Ordinals inscriptions, canonical form:
 *
 *   OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0 <data> OP_ENDIF
 *   OP_DUP OP_HASH160 <owner pkh> OP_EQUALVERIFY OP_CHECKSIG
 *
 * The content-type tag is OP_1 (0x51), never the non-minimal `01 01`. Pushes use
 * minimal encoding up to OP_PUSHDATA4, so any file size works. The trailing
 * P2PKH is what lets any BRC-100 wallet sign the output normally.
 *
 * BSV-21 tokens are inscriptions of content-type "application/bsv-20" whose
 * JSON payload passes the three gates the 1Sat indexer enforces:
 *  1. the content-type tag is OP_1;
 *  2. every JSON value is a string (`"dec":"2"`, not `"dec":2`);
 *  3. a transfer/burn `id` is `<txid>_<vout>` (underscore, not dot).
 */
import { LockingScript, OP, P2PKH, Script, Utils } from '@bsv/sdk'

export interface DecodedInscription {
  contentType: string
  data: number[]
  /** Owner pubkey hash (hex) from the trailing P2PKH. */
  ownerPkh: string
}

/** Build a canonical inscription owned by `ownerPkh` (hex or bytes). */
export function buildInscription (contentType: string, data: number[] | string, ownerPkh: string | number[]): LockingScript {
  const pkh = typeof ownerPkh === 'string' ? Utils.toArray(ownerPkh, 'hex') : ownerPkh
  if (pkh.length !== 20) throw new Error('owner pkh must be 20 bytes')
  const bytes = typeof data === 'string' ? Utils.toArray(data, 'utf8') : data
  const envelope = new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_IF)
    .writeBin(Utils.toArray('ord', 'utf8'))
    .writeOpCode(OP.OP_1)
    .writeBin(Utils.toArray(contentType, 'utf8'))
    .writeOpCode(OP.OP_0)
    .writeBin(bytes)
    .writeOpCode(OP.OP_ENDIF)
  return LockingScript.fromHex(envelope.toHex() + new P2PKH().lock(pkh).toHex())
}

/** Decode a canonical inscription + P2PKH output, or null if it is not one. */
export function decodeInscription (script: LockingScript | Script | string): DecodedInscription | null {
  try {
    const s = typeof script === 'string' ? LockingScript.fromHex(script) : script
    const c = s.chunks
    if (c.length !== 13) return null
    const isPush = (i: number, len?: number): boolean =>
      c[i].data !== undefined && (len === undefined || c[i].data!.length === len)
    if (c[0].op !== OP.OP_FALSE || c[1].op !== OP.OP_IF) return null
    if (!isPush(2) || Utils.toUTF8(c[2].data!) !== 'ord') return null
    if (c[3].op !== OP.OP_1 || c[3].data !== undefined) return null // canonical tag only
    if (!isPush(4)) return null
    if (c[5].op !== OP.OP_0 || (c[5].data !== undefined && c[5].data.length > 0)) return null
    if (c[7].op !== OP.OP_ENDIF) return null
    if (c[8].op !== OP.OP_DUP || c[9].op !== OP.OP_HASH160 || !isPush(10, 20) ||
        c[11].op !== OP.OP_EQUALVERIFY || c[12].op !== OP.OP_CHECKSIG) return null
    return { contentType: Utils.toUTF8(c[4].data!), data: c[6].data ?? [], ownerPkh: Utils.toHex(c[10].data!) }
  } catch {
    return null
  }
}

// ── BSV-21 ────────────────────────────────────────────────────────────────

export type Bsv21Op = 'deploy+mint' | 'transfer' | 'burn'

export interface Bsv21Inscription {
  op: Bsv21Op
  /** Base-10 integer string, 0 … 2^64-1. */
  amt: string
  /** Token id `<txid>_<vout>`; absent on deploy+mint (the deploy outpoint IS the id). */
  id?: string
  sym?: string
  /** Decimal places as a string, '0' … '18'. */
  dec?: string
  icon?: string
}

export interface DecodedBsv21 extends Bsv21Inscription {
  ownerPkh: string
  amount: bigint
}

export const BSV21_CONTENT_TYPE = 'application/bsv-20'
export const MAX_U64 = (1n << 64n) - 1n

const TOKEN_ID_RE = /^[0-9a-f]{64}_\d+$/
const UINT_RE = /^(0|[1-9]\d*)$/

export function isTokenId (id: string): boolean {
  return TOKEN_ID_RE.test(id)
}

export function tokenIdFromOutpoint (txid: string, vout: number): string {
  return `${txid}_${vout}`
}

function validatePayload (p: Record<string, unknown>): Bsv21Inscription {
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string') throw new Error(`BSV-21 field "${k}" must be a string`)
  }
  if (p.p !== 'bsv-20') throw new Error('BSV-21 "p" must be "bsv-20"')
  const op = p.op as string
  if (op !== 'deploy+mint' && op !== 'transfer' && op !== 'burn') throw new Error(`unsupported BSV-21 op "${op}"`)
  const amt = p.amt as string
  if (typeof amt !== 'string' || !UINT_RE.test(amt) || BigInt(amt) > MAX_U64) throw new Error('BSV-21 "amt" must be a uint64 string')
  if (p.dec !== undefined && (!UINT_RE.test(p.dec as string) || Number(p.dec) > 18)) throw new Error('BSV-21 "dec" must be "0".."18"')
  if (op === 'deploy+mint') {
    if (p.id !== undefined) throw new Error('deploy+mint must not carry an id')
  } else if (typeof p.id !== 'string' || !isTokenId(p.id)) {
    throw new Error('BSV-21 "id" must be "<txid>_<vout>"')
  }
  return {
    op,
    amt,
    id: p.id as string | undefined,
    sym: p.sym as string | undefined,
    dec: p.dec as string | undefined,
    icon: p.icon as string | undefined
  }
}

/** Build a canonical BSV-21 locking script owned by `ownerPkh` (hex or byte array). */
export function buildBsv21Script (insc: Bsv21Inscription, ownerPkh: string | number[]): LockingScript {
  const payload: Record<string, string> = { p: 'bsv-20', op: insc.op }
  if (insc.id !== undefined) payload.id = insc.id
  payload.amt = insc.amt
  if (insc.sym !== undefined) payload.sym = insc.sym
  if (insc.dec !== undefined) payload.dec = insc.dec
  if (insc.icon !== undefined) payload.icon = insc.icon
  validatePayload(payload) // never write something we would refuse to read
  return buildInscription(BSV21_CONTENT_TYPE, JSON.stringify(payload), ownerPkh)
}

/**
 * Decode a canonical BSV-21 output. Returns null for anything that is not one
 * (including non-canonical encodings, which the 1Sat indexer also ignores).
 */
export function decodeBsv21 (script: LockingScript | Script | string): DecodedBsv21 | null {
  const insc = decodeInscription(script)
  if (insc === null || insc.contentType !== BSV21_CONTENT_TYPE) return null
  try {
    const json = JSON.parse(Utils.toUTF8(insc.data))
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
    const p = validatePayload(json) // gates 2 and 3
    return { ...p, ownerPkh: insc.ownerPkh, amount: BigInt(p.amt) }
  } catch {
    return null
  }
}
