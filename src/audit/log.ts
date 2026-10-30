/**
 * Tamper-evident audit log: every entry carries the hash of the previous one,
 *
 *   hash = sha256(prev_hash + canonical JSON {seq, at, actor, type, data})
 *
 * with prev_hash = 64 zeros for the first entry. Changing, removing or
 * reordering any row breaks the chain from there on; anchoring the head hash
 * on BSV (src/company/audit-client.ts) also catches a rewritten chain.
 *
 * Appends are serialized (one writer per process). Data never holds secrets:
 * agent API keys appear only as masked hints, and append() refuses anything
 * that looks like a key or token.
 */
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'

export const GENESIS_HASH = '0'.repeat(64)

/** Who did it: the company's rules, the admin (dashboard), an agent, or the company's wallet. */
export type AuditActor = 'rules' | 'admin' | 'company' | `agent:${string}`

export type AuditType =
  | 'agent.created' | 'agent.rules_changed' | 'agent.key_registered'
  | 'request.created' | 'request.decided' | 'request.paid' | 'request.paid_not_delivered' | 'request.failed' | 'request.expired'
  | 'vault.funded' | 'vault.payment' | 'vault.reclaimed'
  | 'request_vault.funded' | 'request_vault.reclaimed'
  | 'audit.anchor_recorded'

export interface AuditEntry {
  seq: number
  at: number
  actor: string
  type: string
  data: Record<string, unknown>
  prevHash: string
  hash: string
}

export interface AuditAnchor {
  seq: number
  hash: string
  txid: string
  at: number
}

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson (value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys((value as Record<string, unknown>)[k])]))
  }
  return value
}

export function entryHash (prevHash: string, e: Pick<AuditEntry, 'seq' | 'at' | 'actor' | 'type' | 'data'>): string {
  const body = canonicalJson({ seq: e.seq, at: e.at, actor: e.actor, type: e.type, data: e.data })
  return createHash('sha256').update(prevHash + body, 'utf8').digest('hex')
}

export type ChainCheck = { ok: true, entries: number } | { ok: false, entries: number, brokenAt: number, reason: string }

/**
 * Checks a run of consecutive entries. Starting at seq 1, the first prev_hash
 * must be the genesis hash; a later start is trusted as given (pass the
 * preceding entry's hash as `prevHash` to check the link too).
 */
export function verifyChain (entries: AuditEntry[], prevHash?: string): ChainCheck {
  let prev = prevHash ?? (entries[0]?.seq === 1 ? GENESIS_HASH : entries[0]?.prevHash)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const broken = (reason: string): ChainCheck => ({ ok: false, entries: entries.length, brokenAt: e.seq, reason })
    if (i > 0 && e.seq !== entries[i - 1].seq + 1) return broken(`seq ${e.seq} follows ${entries[i - 1].seq}`)
    if (e.prevHash !== prev) return broken('prev_hash does not match the previous entry')
    if (entryHash(e.prevHash, e) !== e.hash) return broken('hash does not match the entry')
    prev = e.hash
  }
  return { ok: true, entries: entries.length }
}

// ── No secrets in the log ────────────────────────────────────────────────────

const SECRET_FIELD = /^(api_?key|private_?key|root_?key|priv(ate)?|secret|password|signature|.*token)$/i
const FULL_AGENT_KEY = /agt_[0-9a-f]{64}/i

/** Throws if `data` holds something that looks like a key or token. */
export function assertNoSecrets (data: unknown, path = 'data'): void {
  if (typeof data === 'string') {
    if (FULL_AGENT_KEY.test(data)) throw new Error(`${path} holds an agent API key; log its masked hint instead`)
    return
  }
  if (Array.isArray(data)) { data.forEach((v, i) => { assertNoSecrets(v, `${path}[${i}]`) }); return }
  if (data !== null && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (SECRET_FIELD.test(k)) throw new Error(`${path}.${k} looks like a secret and is not logged`)
      assertNoSecrets(v, `${path}.${k}`)
    }
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

const toEntry = (r: any): AuditEntry => ({
  seq: r.seq, at: r.at, actor: r.actor, type: r.type, data: JSON.parse(r.data), prevHash: r.prev_hash, hash: r.hash
})

/** The last entry the chain was verified up to (kept in memory, shared by every binding of one log). */
interface VerifiedMark { seq: number, hash: string }

export interface AuditStatus {
  seq: number
  hash: string
  /** Entries after the latest anchor, not counting the anchor's own record. */
  unanchoredEntries: number
  latestAnchorSeq: number | null
  /** The log has fewer entries than an anchor covers: its newest entries were deleted. */
  chainShorterThanAnchor: boolean
}

export interface AuditVerifyReport {
  ok: boolean
  brokenAt?: number
  reason?: string
  /** 'incremental' re-checks only the entries after the last verified one; 'full' re-checks everything. */
  mode: 'full' | 'incremental'
  /** Entries in the log, and how many this run re-hashed. */
  entries: number
  checked: number
  /** The chain is known good up to this seq (0 when nothing is). */
  verifiedThrough: number
  chainShorterThanAnchor: boolean
  anchors: Array<AuditAnchor & { matches: boolean }>
}

export class AuditLog {
  private tail: Promise<unknown> = Promise.resolve()

  constructor (
    private readonly db: Knex,
    private readonly now: () => number = Date.now,
    private readonly state: { verified: VerifiedMark | null } = { verified: null },
    private readonly inTransaction = false
  ) {}

  /**
   * The same log, writing inside `trx`: the entry commits or rolls back with
   * the state change it records.
   */
  with (trx: Knex.Transaction): AuditLog {
    return new AuditLog(trx, this.now, this.state, true)
  }

  /** Runs `fn` with this log bound to one new transaction. */
  async transaction<T> (fn: (audit: AuditLog) => Promise<T>): Promise<T> {
    return await this.db.transaction(async trx => await fn(this.with(trx)))
  }

  /**
   * Appends one entry. Inside a transaction (see with()) the single database
   * connection serializes writers; on its own, appends are queued and each runs
   * in its own transaction.
   */
  async append (actor: AuditActor, type: AuditType, data: Record<string, unknown>): Promise<AuditEntry> {
    assertNoSecrets(data)
    // Drop undefined fields, exactly as the stored JSON will.
    const clean = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
    if (this.inTransaction) return await this.insert(this.db, actor, type, clean)
    const run = this.tail.catch(() => {}).then(async () => await this.db.transaction(async trx => await this.insert(trx, actor, type, clean)))
    this.tail = run
    return await run
  }

  private async insert (q: Knex, actor: string, type: string, data: Record<string, unknown>): Promise<AuditEntry> {
    const last = await q('audit_log').orderBy('seq', 'desc').first()
    const prevHash: string = last?.hash ?? GENESIS_HASH
    const entry = { seq: (last?.seq ?? 0) + 1, at: this.now(), actor, type, data }
    const hash = entryHash(prevHash, entry)
    await q('audit_log').insert({ ...entry, data: JSON.stringify(data), prev_hash: prevHash, hash })
    return { ...entry, prevHash, hash }
  }

  async head (): Promise<{ seq: number, hash: string }> {
    const last = await this.db('audit_log').orderBy('seq', 'desc').first()
    return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH }
  }

  /** The head, and how much of the log no anchor covers yet. */
  async status (): Promise<AuditStatus> {
    const head = await this.head()
    const latest = await this.db('audit_anchors').max({ seq: 'seq' }).first()
    const latestAnchorSeq = (latest?.seq as number | null | undefined) ?? null
    const unanchored = await this.db('audit_log').where('seq', '>', latestAnchorSeq ?? 0)
      .whereNot({ type: 'audit.anchor_recorded' }).count({ n: '*' }).first()
    return {
      ...head,
      unanchoredEntries: Number(unanchored?.n ?? 0),
      latestAnchorSeq,
      chainShorterThanAnchor: latestAnchorSeq !== null && head.seq < latestAnchorSeq
    }
  }

  async get (seq: number): Promise<AuditEntry | undefined> {
    const row = await this.db('audit_log').where({ seq }).first()
    return row === undefined ? undefined : toEntry(row)
  }

  /** Entries with seq > after, oldest first. */
  async list (after = 0, limit = 1000): Promise<AuditEntry[]> {
    return (await this.db('audit_log').where('seq', '>', after).orderBy('seq', 'asc').limit(limit)).map(toEntry)
  }

  /** The newest `limit` entries, newest first. */
  async latest (limit: number): Promise<AuditEntry[]> {
    return (await this.db('audit_log').orderBy('seq', 'desc').limit(limit)).map(toEntry)
  }

  async all (): Promise<AuditEntry[]> {
    return (await this.db('audit_log').orderBy('seq', 'asc')).map(toEntry)
  }

  async addAnchor (a: AuditAnchor): Promise<void> {
    await this.db('audit_anchors').insert(a)
  }

  async anchors (): Promise<AuditAnchor[]> {
    return await this.db('audit_anchors').orderBy('seq', 'asc').select('seq', 'hash', 'txid', 'at')
  }

  /**
   * Verifies the chain and every anchor. By default only the entries after the
   * last verified one are re-hashed, after checking that this one is unchanged;
   * any mismatch drops the mark and the next run re-checks everything.
   * `full` always re-checks the whole chain.
   */
  async verify (opts: { full?: boolean } = {}): Promise<AuditVerifyReport> {
    const count = Number((await this.db('audit_log').count({ n: '*' }).first())?.n ?? 0)
    let mode: 'full' | 'incremental' = 'full'
    let check: ChainCheck
    let checked: number
    const mark = opts.full === true ? null : this.state.verified
    const markEntry = mark === null ? undefined : await this.get(mark.seq)

    if (mark !== null && markEntry?.hash === mark.hash) {
      mode = 'incremental'
      const rest = await this.list(mark.seq, Number.MAX_SAFE_INTEGER)
      checked = rest.length
      check = rest.length > 0 && rest[0].seq !== mark.seq + 1
        ? { ok: false, entries: rest.length, brokenAt: rest[0].seq, reason: `seq ${rest[0].seq} follows ${mark.seq}` }
        : verifyChain(rest, mark.hash)
    } else {
      const all = await this.all()
      checked = all.length
      check = verifyChain(all, GENESIS_HASH)
    }

    const head = await this.head()
    this.state.verified = check.ok && head.seq > 0 ? { seq: head.seq, hash: head.hash } : null

    const anchorRows = await this.anchors()
    const hashes = new Map((await this.db('audit_log').whereIn('seq', anchorRows.map(a => a.seq)).select('seq', 'hash')).map(r => [r.seq as number, r.hash as string]))
    const anchors = anchorRows.map(a => ({ ...a, matches: hashes.get(a.seq) === a.hash }))
    const latestAnchorSeq = anchorRows.reduce((m, a) => Math.max(m, a.seq), 0)
    const chainShorterThanAnchor = latestAnchorSeq > head.seq

    const report: AuditVerifyReport = {
      ok: check.ok, mode, entries: count, checked, verifiedThrough: this.state.verified?.seq ?? 0, chainShorterThanAnchor, anchors
    }
    if (!check.ok) return { ...report, brokenAt: check.brokenAt, reason: check.reason }
    if (chainShorterThanAnchor) {
      return { ...report, ok: false, brokenAt: head.seq + 1, reason: `the log ends at #${head.seq} but anchor #${latestAnchorSeq} exists: its newest entries were deleted` }
    }
    return report
  }
}
