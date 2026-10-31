/**
 * Vault v2: the v1 vault (./script.ts) plus an OP_PUSH_TX covenant on the
 * agent + policy branch, so every BSV node enforces the payment shape:
 *
 *   OP_IF   <agent check> <policy check> <covenant>
 *   OP_ELSE <companyPub> OP_CHECKSIG
 *   OP_ENDIF
 *
 * SAFETY: the company's reclaim branch is exactly v1's `<companyPub> OP_CHECKSIG`,
 * with no covenant, so the company can always take the funds back even if the
 * covenant had a bug. Reclaim unlocking: <sigCompany> OP_0, as in v1.
 *
 * Spend unlocking: <sigPolicy> <sigAgent> <outputsBlob> <preimage> OP_1
 *   outputsBlob = the transaction's serialized outputs (value 8 LE | varint | script, …)
 *   preimage    = the BIP-143 preimage of this input (SIGHASH_ALL | FORKID)
 *
 * The covenant accepts exactly these outputs:
 *   0: any script shorter than 253 bytes, value ≤ MAX_SATS (the agent's
 *      maxPerPaymentSats when the vault was funded);
 *   then optionally: change, locked to this very vault script (any value);
 *   then optionally, last: a 0-sat `OP_FALSE OP_RETURN "agenttresor-audit" …` anchor;
 *   nothing else;
 * and the fee (input value − output 0 − change) is at most MAX_FEE. So a
 * payment without change is only possible when the vault holds at most
 * MAX_SATS + MAX_FEE: nobody can send the rest of a vault to the miners.
 *
 * OP_PUSH_TX (nChain, "OP_PUSH_TX", WP1605; as used by sCrypt's Tx.checkPreimage):
 * the script proves <preimage> is the real one by building an ECDSA signature
 * over hash256(preimage) with the well-known private key d = 1 and nonce k = 1,
 * then checking it against G with OP_CHECKSIGVERIFY. With d = k = 1:
 *   r = Gx,   s = k⁻¹(z + r·d) = (z + r) mod n,   z = hash256(preimage) as a big-endian integer.
 * The node computes the real preimage for that signature check, so the
 * signature only verifies if <preimage> is it. To keep the DER encoding fixed,
 * the builder grinds nLockTime (every input keeps nSequence 0xffffffff, so
 * nLockTime has no effect) until 2^248 ≤ s ≤ n/2: s is then exactly 32 bytes,
 * its first byte is 0x01..0x7f and it is low-S. The script requires that form.
 */
import { Hash, LockingScript, OP, PublicKey, Transaction, UnlockingScript, Utils, type Signature } from '../shared/bsv.js'
import { ANCHOR_TAG } from '../audit/anchor-script.js'
import { checksigBytes, parseVaultScript, vaultLockingScript, vaultPreimage, type VaultKeys } from './script.js'

/** What a v2 vault enforces besides its shape. */
export interface CovenantCaps {
  /** Highest value output 0 may carry, in satoshis. */
  maxSats: number
  /** Highest fee a payment may pay, in satoshis. */
  maxFeeSats: number
}

export interface CovenantParams extends VaultKeys, CovenantCaps {}

/** MAX_FEE when nothing else is set: the agent signer's default fee limit too (a v2 payment costs about 280 sats at 100 sat/kB). */
export const DEFAULT_COVENANT_MAX_FEE_SATS = 1_000

// ── secp256k1 constants ──────────────────────────────────────────────────────

/** G, compressed: the public key of d = 1. */
export const G_COMPRESSED = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
/** r = Gx (k = 1). */
const R = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HALF_N = N >> 1n
const S_MIN = 1n << 248n

/** First bytes of the signature: 30 44 02 20 <r, 32 bytes> 02 20 (s and the sighash byte follow). */
const DER_PREFIX = [0x30, 0x44, 0x02, 0x20, ...Utils.toArray(R.toString(16).padStart(64, '0'), 'hex'), 0x02, 0x20]
const SIGHASH_ALL_FORKID = 0x41
/** The start of every audit anchor script: OP_FALSE OP_RETURN, then the 17-byte tag pushed. */
const ANCHOR_PREFIX = [OP.OP_FALSE, OP.OP_RETURN, ANCHOR_TAG.length, ...Utils.toArray(ANCHOR_TAG, 'utf8')]

/** BIP-143 preimage: the scriptCode (with its varint) starts here: version 4 + hashPrevouts 32 + hashSequence 32 + outpoint 36. */
const SCRIPT_CODE_OFFSET = 104
/** …and is followed by value 8 (the input's value) + nSequence 4 … */
const AFTER_SCRIPT_CODE = 12
const VALUE_LENGTH = 8
/** …hashOutputs 32 + nLockTime 4 + sighashType 4 at the end. */
const PREIMAGE_TAIL = 40

/** How long the builder grinds nLockTime; each try succeeds with probability ≈ 1/2. */
export const MAX_GRIND_TRIES = 256

// ── Script building blocks ───────────────────────────────────────────────────

interface Chunk { op: number, data?: number[] }

const op = (o: number): Chunk => ({ op: o })

/** A minimal data push. */
function pushData (data: number[]): Chunk {
  if (data.length === 0) return { op: OP.OP_0 }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 0xff) return { op: OP.OP_PUSHDATA1, data }
  if (data.length <= 0xffff) return { op: OP.OP_PUSHDATA2, data }
  return { op: OP.OP_PUSHDATA4, data }
}

/** A script number: little-endian sign-magnitude, minimally encoded. */
export function scriptNum (n: bigint): number[] {
  if (n === 0n) return []
  const negative = n < 0n
  let m = negative ? -n : n
  const out: number[] = []
  while (m > 0n) { out.push(Number(m & 0xffn)); m >>= 8n }
  if ((out[out.length - 1] & 0x80) !== 0) out.push(negative ? 0x80 : 0x00)
  else if (negative) out[out.length - 1] |= 0x80
  return out
}

/** Pushes a number, with OP_0 / OP_1..OP_16 where they exist. */
function num (n: bigint | number): Chunk {
  const v = BigInt(n)
  if (v === 0n) return op(OP.OP_0)
  if (v >= 1n && v <= 16n) return op(OP.OP_1 + Number(v) - 1)
  return pushData(scriptNum(v))
}

/** Reverses the 32-byte item on top: split off 31 single bytes, then concatenate them back in reverse. */
const REVERSE_32: Chunk[] = [
  ...Array.from({ length: 31 }, () => [op(OP.OP_1), op(OP.OP_SPLIT)]).flat(),
  ...Array.from({ length: 31 }, () => [op(OP.OP_SWAP), op(OP.OP_CAT)]).flat()
]

/** <bytes> → the unsigned number they encode (little-endian), via a 0x00 sign byte. */
const LE_TO_NUM: Chunk[] = [pushData([0x00]), op(OP.OP_CAT), op(OP.OP_BIN2NUM)]

const SIZE_OF_TOP: Chunk[] = [op(OP.OP_SIZE), op(OP.OP_NIP)]

function covenantChunks (p: CovenantParams): { chunks: Chunk[], maxIndex: number, maxFeeIndex: number } {
  const maxChunk = num(p.maxSats)
  const maxFeeChunk = num(p.maxFeeSats)
  const chunks: Chunk[] = [
    op(OP.OP_IF),
    // Stack: sigPolicy sigAgent blob preimage. Bring the signatures up.
    op(OP.OP_2SWAP), //                                         blob preimage sigPolicy sigAgent
    // Agent and policy checks, as in v1 (the policy check verifies: the covenant decides the result).
    pushData(Utils.toArray(p.agentPub, 'hex')), op(OP.OP_CHECKSIGVERIFY), //   blob preimage sigPolicy
    pushData(Utils.toArray(p.policyPub, 'hex')), op(OP.OP_CHECKSIGVERIFY), //  blob preimage

    // ── 1. OP_PUSH_TX: <preimage> is this transaction's real BIP-143 preimage ──
    op(OP.OP_DUP), op(OP.OP_HASH256), //                        blob preimage z(BE bytes)
    ...REVERSE_32, ...LE_TO_NUM, //                             blob preimage z
    pushData(scriptNum(R)), op(OP.OP_ADD), pushData(scriptNum(N)), op(OP.OP_MOD), // blob preimage s
    // The ground form: 2^248 ≤ s ≤ n/2 (32 bytes, first byte 0x01..0x7f, low-S).
    op(OP.OP_DUP), pushData(scriptNum(S_MIN)), op(OP.OP_GREATERTHANOREQUAL), op(OP.OP_VERIFY),
    op(OP.OP_DUP), pushData(scriptNum(HALF_N)), op(OP.OP_LESSTHANOREQUAL), op(OP.OP_VERIFY),
    num(32), op(OP.OP_NUM2BIN), ...REVERSE_32, //               blob preimage s(BE, 32 bytes)
    pushData(DER_PREFIX), op(OP.OP_SWAP), op(OP.OP_CAT), pushData([SIGHASH_ALL_FORKID]), op(OP.OP_CAT), // blob preimage sig
    pushData(Utils.toArray(G_COMPRESSED, 'hex')), op(OP.OP_CHECKSIGVERIFY), // blob preimage

    // ── 2. Parse the preimage: hashOutputs, the scriptCode with its varint, the input value ──
    op(OP.OP_SIZE), num(PREIMAGE_TAIL), op(OP.OP_SUB), op(OP.OP_SPLIT), //    blob head tail40
    num(32), op(OP.OP_SPLIT), op(OP.OP_DROP), //                blob head hashOutputs
    op(OP.OP_SWAP), //                                          blob hashOutputs head
    num(SCRIPT_CODE_OFFSET), op(OP.OP_SPLIT), op(OP.OP_NIP), // blob hashOutputs rest
    op(OP.OP_SIZE), num(AFTER_SCRIPT_CODE), op(OP.OP_SUB), op(OP.OP_SPLIT), // blob hashOutputs code tail12
    num(VALUE_LENGTH), op(OP.OP_SPLIT), op(OP.OP_DROP), ...LE_TO_NUM, // blob hashOutputs code inputValue
    // The altstack keeps "input value − outputs read so far"; what is left at the end is the fee.
    op(OP.OP_TOALTSTACK), //                                    blob hashOutputs code     alt: left
    op(OP.OP_SWAP), //                                          blob code hashOutputs

    // ── 3. The outputs given are the outputs signed: hash256(blob) == hashOutputs ──
    op(OP.OP_2), op(OP.OP_PICK), op(OP.OP_HASH256), op(OP.OP_EQUALVERIFY), // blob code
    op(OP.OP_SWAP), //                                          code blob

    // ── 4. Output 0: value ≤ MAX_SATS, script shorter than 253 bytes ──
    num(8), op(OP.OP_SPLIT), op(OP.OP_SWAP), ...LE_TO_NUM, //   code rest value0
    op(OP.OP_DUP), maxChunk, op(OP.OP_LESSTHANOREQUAL), op(OP.OP_VERIFY), // code rest value0
    op(OP.OP_FROMALTSTACK), op(OP.OP_SWAP), op(OP.OP_SUB), op(OP.OP_TOALTSTACK), // code rest   alt: left − value0
    op(OP.OP_1), op(OP.OP_SPLIT), op(OP.OP_SWAP), ...LE_TO_NUM, // code rest len0
    op(OP.OP_DUP), num(253), op(OP.OP_LESSTHAN), op(OP.OP_VERIFY),
    op(OP.OP_SPLIT), op(OP.OP_NIP), //                          code rest (after output 0)

    // ── Optional change: room for it means it must be there: 8-byte value, then exactly this vault's varint + script ──
    op(OP.OP_OVER), ...SIZE_OF_TOP, num(8), op(OP.OP_ADD), //   code rest 8+|code|
    op(OP.OP_OVER), ...SIZE_OF_TOP, //                          code rest 8+|code| |rest|
    op(OP.OP_LESSTHANOREQUAL),
    op(OP.OP_IF),
    num(8), op(OP.OP_SPLIT), op(OP.OP_SWAP), ...LE_TO_NUM, //   code rest changeValue (any amount)
    op(OP.OP_FROMALTSTACK), op(OP.OP_SWAP), op(OP.OP_SUB), op(OP.OP_TOALTSTACK), // code rest   alt: left − change
    op(OP.OP_OVER), ...SIZE_OF_TOP, op(OP.OP_SPLIT), //         code candidate rest
    op(OP.OP_TOALTSTACK), op(OP.OP_EQUALVERIFY), op(OP.OP_FROMALTSTACK), // rest
    op(OP.OP_ELSE),
    op(OP.OP_NIP), //                                           rest
    op(OP.OP_ENDIF),

    // ── Optional anchor, last: value 0, its varint covers exactly what is left, AgentTresor prefix ──
    op(OP.OP_SIZE),
    op(OP.OP_IF),
    num(8), op(OP.OP_SPLIT), op(OP.OP_SWAP), pushData(new Array(8).fill(0)), op(OP.OP_EQUALVERIFY), // anchor
    op(OP.OP_1), op(OP.OP_SPLIT), op(OP.OP_SWAP), ...LE_TO_NUM, // script len
    op(OP.OP_OVER), ...SIZE_OF_TOP, op(OP.OP_NUMEQUALVERIFY), // script
    num(ANCHOR_PREFIX.length), op(OP.OP_SPLIT), op(OP.OP_DROP), pushData(ANCHOR_PREFIX), op(OP.OP_EQUALVERIFY),
    op(OP.OP_ELSE),
    op(OP.OP_DROP), //                                          (nothing was left)
    op(OP.OP_ENDIF),
    // ── 5. The fee: what is left of the input value (the anchor holds 0) ──
    op(OP.OP_FROMALTSTACK), maxFeeChunk, op(OP.OP_LESSTHANOREQUAL), // fee ≤ MAX_FEE: the branch's result

    op(OP.OP_ELSE),
    // Reclaim: exactly v1. No covenant here, ever.
    pushData(Utils.toArray(p.companyPub, 'hex')), op(OP.OP_CHECKSIG),
    op(OP.OP_ENDIF)
  ]
  return { chunks, maxIndex: chunks.indexOf(maxChunk), maxFeeIndex: chunks.indexOf(maxFeeChunk) }
}

/** Where the MAX_SATS and MAX_FEE pushes sit; every other push in the script has a fixed position too. */
const LAYOUT = covenantChunks({ agentPub: G_COMPRESSED, policyPub: G_COMPRESSED, companyPub: G_COMPRESSED, maxSats: 0, maxFeeSats: 0 })
const MAX_SATS_CHUNK = LAYOUT.maxIndex
const MAX_FEE_FROM_END = LAYOUT.chunks.length - LAYOUT.maxFeeIndex

/** The v2 vault script. Throws on bad keys or a bad cap. */
export function covenantLockingScript (p: CovenantParams): LockingScript {
  if (!Number.isSafeInteger(p.maxSats) || p.maxSats < 0) throw new Error('maxSats must be a non-negative whole number of satoshis')
  if (!Number.isSafeInteger(p.maxFeeSats) || p.maxFeeSats < 0) throw new Error('maxFeeSats must be a non-negative whole number of satoshis')
  vaultLockingScript({ agentPub: p.agentPub, policyPub: p.policyPub, companyPub: p.companyPub }) // checks the three keys
  return new LockingScript(covenantChunks(p).chunks)
}

/** The keys and cap of a v2 vault script, or undefined if the script is not exactly one. */
export function parseCovenantScript (script: LockingScript | string): CovenantParams | undefined {
  let s: LockingScript
  try { s = typeof script === 'string' ? LockingScript.fromHex(script) : script } catch { return undefined }
  const c = s.chunks
  if (c.length < MAX_SATS_CHUNK + 10) return undefined
  const hex = (i: number): string => c[i]?.data === undefined ? '' : Utils.toHex(c[i].data!)
  const maxSats = smallNum(c[MAX_SATS_CHUNK])
  const maxFeeSats = smallNum(c[c.length - MAX_FEE_FROM_END])
  if (maxSats === undefined || maxFeeSats === undefined) return undefined
  const params = { agentPub: hex(2), policyPub: hex(4), companyPub: hex(c.length - 3), maxSats, maxFeeSats }
  try {
    return covenantLockingScript(params).toHex() === s.toHex() ? params : undefined
  } catch {
    return undefined
  }
}

/** A pushed number of at most 7 bytes (enough for any satoshi amount), or undefined. */
function smallNum (chunk: Chunk | undefined): number | undefined {
  if (chunk === undefined) return undefined
  if (chunk.op === OP.OP_0) return 0
  if (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16) return chunk.op - OP.OP_1 + 1
  if (chunk.data !== undefined && chunk.data.length <= 7) return Number(decodeScriptNum(chunk.data))
  return undefined
}

function decodeScriptNum (bytes: number[]): bigint {
  if (bytes.length === 0) return 0n
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(i === bytes.length - 1 ? bytes[i] & 0x7f : bytes[i])
  return (bytes[bytes.length - 1] & 0x80) !== 0 ? -n : n
}

/** A vault script of either version: its keys, and the covenant cap for v2. */
export type VaultSource = (VaultKeys & { version: 1 }) | (CovenantParams & { version: 2 })

export function parseVaultSource (script: LockingScript | string): VaultSource | undefined {
  const v1 = parseVaultScript(script)
  if (v1 !== undefined) return { ...v1, version: 1 }
  const v2 = parseCovenantScript(script)
  return v2 === undefined ? undefined : { ...v2, version: 2 }
}

// ── Spending a v2 vault ──────────────────────────────────────────────────────

/** The transaction's outputs as BIP-143 hashes them (hash256 of this is hashOutputs). */
export function outputsBlob (tx: Transaction): number[] {
  const w = new Utils.Writer()
  for (const o of tx.outputs) {
    const script = o.lockingScript.toBinary()
    w.writeUInt64LE(o.satoshis ?? 0)
    w.writeVarIntNum(script.length)
    w.write(script)
  }
  return w.toArray()
}

/** s of the OP_PUSH_TX signature for this preimage. */
export function pushTxS (preimage: number[]): bigint {
  const z = BigInt(`0x${Utils.toHex(Hash.hash256(preimage))}`)
  return (z + R) % N
}

/** Whether s has the form the covenant requires (32 bytes, first byte 0x01..0x7f, low-S). */
export function isGroundS (s: bigint): boolean {
  return s >= S_MIN && s <= HALF_N
}

/**
 * Sets tx.lockTime (0, 1, 2, …) until the OP_PUSH_TX signature of input
 * `inputIndex` has the required form; returns how many tries it took. Every
 * input must have nSequence 0xffffffff, so the lock time has no effect.
 */
export function grindLockTime (tx: Transaction, inputIndex: number, sourceSatoshis: number, lockingScript: LockingScript): number {
  if (tx.inputs.some(i => (i.sequence ?? 0xffffffff) !== 0xffffffff)) throw new Error('every input must have nSequence 0xffffffff to grind nLockTime')
  for (let tries = 1; tries <= MAX_GRIND_TRIES; tries++) {
    tx.lockTime = tries - 1
    if (isGroundS(pushTxS(vaultPreimage(tx, inputIndex, sourceSatoshis, lockingScript)))) return tries
  }
  throw new Error(`no usable nLockTime in ${MAX_GRIND_TRIES} tries`)
}

/** The spend path's unlocking script. The transaction must already be ground (see grindLockTime). */
export function covenantUnlockingScript (
  policySig: Signature, agentSig: Signature, tx: Transaction, inputIndex: number, sourceSatoshis: number, lockingScript: LockingScript
): UnlockingScript {
  const preimage = vaultPreimage(tx, inputIndex, sourceSatoshis, lockingScript)
  return new UnlockingScript([
    pushData(checksigBytes(policySig)),
    pushData(checksigBytes(agentSig)),
    pushData(outputsBlob(tx)),
    pushData(preimage),
    op(OP.OP_1)
  ])
}

const pushLength = (n: number): number => n + (n <= 75 ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5)
const varIntLength = (n: number): number => n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9
/** A checksig signature push: 1 length byte + up to 72 bytes DER + 1 sighash byte. */
const SIG_PUSH = 74

/** Upper bound of the spend path's unlocking script, for fee estimation. */
export function covenantSpendUnlockLength (tx: Transaction, lockingScriptLength: number): number {
  const preimageLength = SCRIPT_CODE_OFFSET + varIntLength(lockingScriptLength) + lockingScriptLength + AFTER_SCRIPT_CODE + PREIMAGE_TAIL
  return 2 * SIG_PUSH + pushLength(outputsBlob(tx).length) + pushLength(preimageLength) + 1
}

/** Whether `pub` is G (used by tests: nobody may use d = 1 for anything else). */
export const isGenerator = (pub: string): boolean => PublicKey.fromString(pub).toString() === G_COMPRESSED
