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

export class AuditLog {
  private tail: Promise<unknown> = Promise.resolve()

  constructor (private readonly db: Knex, private readonly now: () => number = Date.now) {}

  /** Appends one entry. Appends run one at a time, each in its own transaction. */
  async append (actor: AuditActor, type: AuditType, data: Record<string, unknown>): Promise<AuditEntry> {
    assertNoSecrets(data)
    // Drop undefined fields, exactly as the stored JSON will.
    const clean = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
    const run = this.tail.catch(() => {}).then(async () => await this.db.transaction(async trx => {
      const last = await trx('audit_log').orderBy('seq', 'desc').first()
      const prevHash: string = last?.hash ?? GENESIS_HASH
      const entry = { seq: (last?.seq ?? 0) + 1, at: this.now(), actor, type, data: clean }
      const hash = entryHash(prevHash, entry)
      await trx('audit_log').insert({ ...entry, data: JSON.stringify(clean), prev_hash: prevHash, hash })
      return { ...entry, prevHash, hash }
    }))
    this.tail = run
    return await run
  }

  async head (): Promise<{ seq: number, hash: string }> {
    const last = await this.db('audit_log').orderBy('seq', 'desc').first()
    return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH }
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

  /** The whole chain, and whether every anchored hash still matches the entry at its seq. */
  async verify (): Promise<ChainCheck & { anchors: Array<AuditAnchor & { matches: boolean }> }> {
    const entries = await this.all()
    const bySeq = new Map(entries.map(e => [e.seq, e.hash]))
    const anchors = (await this.anchors()).map(a => ({ ...a, matches: bySeq.get(a.seq) === a.hash }))
    return { ...verifyChain(entries, GENESIS_HASH), anchors }
  }
}
