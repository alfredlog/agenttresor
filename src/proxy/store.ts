/**
 * Proxy storage (knex + better-sqlite3). Migrations live in code and run on open.
 * API keys are stored as sha256 only.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import makeKnex, { type Knex } from 'knex'
import type { MerchantAnswer } from '../shared/merchant.js'
import { DEFAULT_RULES, isEur, type Rules } from './rules.js'

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'paid' | 'paid_not_delivered' | 'failed' | 'expired'
export const REQUEST_STATUSES: RequestStatus[] = ['pending', 'approved', 'denied', 'paid', 'paid_not_delivered', 'failed', 'expired']
/** Statuses whose satoshis have left the wallet: both count against the budget. */
export const SPENT_STATUSES: RequestStatus[] = ['paid', 'paid_not_delivered']

/** disabled: no key, no codes, every request refused until enabled. deleted: hidden, never usable again; its history stays. */
export type AgentStatus = 'active' | 'disabled' | 'deleted'

export interface Agent {
  id: string
  name: string
  keyHint: string
  createdAt: number
  status: AgentStatus
}

export type { MerchantAnswer } from '../shared/merchant.js'

export interface PaymentRequestRecord {
  id: string
  agentId: string
  url: string
  method: string
  body: unknown
  purpose: string
  priceSats: number | null
  /** Merchant identity key from the 402 challenge. */
  serverKey: string | null
  status: RequestStatus
  reason: string | null
  txid: string | null
  response: MerchantAnswer | null
  createdAt: number
  decidedAt: number | null
  decidedBy: string | null
  paidAt: number | null
  /** The BSV/EUR rate used for this request (€ per BSV), if one was available. */
  eurRate: number | null
  /** The price in euro cents at that rate, rounded up. */
  eurCents: number | null
  rateSource: string | null
  /** When the source last updated that rate. */
  rateAt: number | null
}

const MIGRATIONS: Record<string, Knex.Migration> = {
  '001_initial': {
    async up (k) {
      await k.schema.createTable('agents', t => {
        t.string('id').primary()
        t.string('name').notNullable()
        t.string('key_hash').notNullable().unique()
        t.string('key_hint').notNullable()
        t.bigInteger('created_at').notNullable()
      })
      await k.schema.createTable('rules', t => {
        t.string('agent_id').primary().references('agents.id')
        t.text('allowed_hosts').notNullable()
        t.bigInteger('max_per_payment_sats').notNullable()
        t.bigInteger('daily_budget_sats').notNullable()
        t.bigInteger('approval_threshold_sats').notNullable()
      })
      await k.schema.createTable('requests', t => {
        t.string('id').primary()
        t.string('agent_id').notNullable().references('agents.id')
        t.text('url').notNullable()
        t.string('method').notNullable()
        t.text('body')
        t.text('purpose').notNullable()
        t.bigInteger('price_sats')
        t.string('server_key')
        t.string('status').notNullable()
        t.text('reason')
        t.string('txid')
        t.text('response')
        t.bigInteger('created_at').notNullable()
        t.bigInteger('decided_at')
        t.string('decided_by')
        t.bigInteger('paid_at')
        t.index(['agent_id', 'status'])
        t.index(['status'])
      })
    },
    async down (k) {
      await k.schema.dropTable('requests')
      await k.schema.dropTable('rules')
      await k.schema.dropTable('agents')
    }
  },
  '002_vaults': {
    async up (k) {
      // One vault per agent; the current UTXO and the BEEF that proves it.
      await k.schema.createTable('vaults', t => {
        t.string('agent_id').primary().references('agents.id')
        t.string('agent_pub').notNullable()
        t.string('company_pub')
        t.text('locking_script')
        t.string('status').notNullable()
        t.string('txid')
        t.integer('vout')
        t.bigInteger('satoshis')
        t.text('beef')
        t.bigInteger('created_at').notNullable()
        t.bigInteger('updated_at').notNullable()
      })
      // Every vault transaction: funding, payments (with the signing attempt), reclaim.
      await k.schema.createTable('vault_txs', t => {
        t.string('id').primary()
        t.string('agent_id').notNullable().references('agents.id')
        t.string('request_id')
        t.string('kind').notNullable()
        t.string('status').notNullable()
        t.string('txid')
        t.string('input_outpoint')
        t.text('unsigned_tx')
        t.bigInteger('price_sats')
        t.bigInteger('fee_sats')
        t.bigInteger('change_sats')
        t.string('server_key')
        t.string('nonce')
        t.string('time_ms')
        t.text('reason')
        t.bigInteger('created_at').notNullable()
        t.bigInteger('updated_at').notNullable()
        t.index(['agent_id', 'status'])
        t.index(['request_id'])
      })
    },
    async down (k) {
      await k.schema.dropTable('vault_txs')
      await k.schema.dropTable('vaults')
    }
  },
  '003_request_vaults': {
    async up (k) {
      // One vault UTXO per payment a human approved: the company's approval is this funding.
      await k.schema.createTable('request_vaults', t => {
        t.string('request_id').primary().references('requests.id')
        t.string('agent_id').notNullable().references('agents.id')
        t.string('txid').notNullable()
        t.integer('vout').notNullable()
        t.bigInteger('satoshis').notNullable()
        t.text('locking_script').notNullable()
        t.string('company_pub').notNullable()
        t.text('beef').notNullable()
        t.string('status').notNullable()
        t.string('closing_txid')
        t.bigInteger('created_at').notNullable()
        t.bigInteger('updated_at').notNullable()
        t.index(['status'])
      })
    },
    async down (k) {
      await k.schema.dropTable('request_vaults')
    }
  },
  '004_audit_log': {
    async up (k) {
      // Hash-chained, append-only audit log (src/audit/log.ts).
      await k.schema.createTable('audit_log', t => {
        t.integer('seq').primary()
        t.bigInteger('at').notNullable()
        t.string('actor').notNullable()
        t.string('type').notNullable()
        t.text('data').notNullable()
        t.string('prev_hash').notNullable()
        t.string('hash').notNullable()
      })
      // On-chain anchors of the log head, made by the company's own wallet.
      await k.schema.createTable('audit_anchors', t => {
        t.string('txid').primary()
        t.integer('seq').notNullable()
        t.string('hash').notNullable()
        t.bigInteger('at').notNullable()
        t.index(['seq'])
      })
    },
    async down (k) {
      await k.schema.dropTable('audit_anchors')
      await k.schema.dropTable('audit_log')
    }
  },
  '005_connect_codes': {
    async up (k) {
      // One-time connection codes (src/proxy/connect.ts), stored as sha256 only.
      await k.schema.createTable('connect_codes', t => {
        t.string('code_hash').primary()
        t.string('agent_id').notNullable().references('agents.id')
        t.bigInteger('expires_at').notNullable()
        t.bigInteger('used_at')
        t.bigInteger('created_at').notNullable()
        t.index(['agent_id'])
      })
    },
    async down (k) {
      await k.schema.dropTable('connect_codes')
    }
  },
  '006_agent_status': {
    async up (k) {
      // Agents are disabled or deleted, never removed: their requests, ledger and audit entries reference them.
      await k.schema.alterTable('agents', t => {
        t.string('status').notNullable().defaultTo('active')
        t.bigInteger('status_changed_at')
      })
    },
    async down (k) {
      await k.schema.alterTable('agents', t => {
        t.dropColumn('status_changed_at')
        t.dropColumn('status')
      })
    }
  },
  '007_anchor_source': {
    async up (k) {
      // Who made an anchor: the company's wallet (dashboard), a vault payment, or the operator's notary wallet.
      await k.schema.alterTable('audit_anchors', t => {
        t.string('source').notNullable().defaultTo('company')
        t.integer('fee_sats')
      })
    },
    async down (k) {
      await k.schema.alterTable('audit_anchors', t => {
        t.dropColumn('fee_sats')
        t.dropColumn('source')
      })
    }
  },
  '008_eur_budgets': {
    async up (k) {
      // Budgets in euros: EUR rules keep their limits in cents (the *_sats columns are 0 for them).
      await k.schema.alterTable('rules', t => {
        t.string('currency').notNullable().defaultTo('SAT')
        t.bigInteger('max_per_payment_cents')
        t.bigInteger('daily_budget_cents')
        t.bigInteger('approval_threshold_cents')
      })
      // The rate each request was judged (and paid) at, for EUR budgets and for accounting.
      await k.schema.alterTable('requests', t => {
        t.double('eur_rate')
        t.bigInteger('eur_cents')
        t.string('rate_source')
        t.bigInteger('rate_at')
      })
    },
    async down (k) {
      await k.schema.alterTable('requests', t => {
        t.dropColumn('rate_at')
        t.dropColumn('rate_source')
        t.dropColumn('eur_cents')
        t.dropColumn('eur_rate')
      })
      await k.schema.alterTable('rules', t => {
        t.dropColumn('approval_threshold_cents')
        t.dropColumn('daily_budget_cents')
        t.dropColumn('max_per_payment_cents')
        t.dropColumn('currency')
      })
    }
  }
}

const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(MIGRATIONS),
  getMigrationName: name => name,
  getMigration: async name => MIGRATIONS[name]
}

/** Opens (and migrates) the proxy database. Use ':memory:' in tests. */
export async function openProxyDb (filename = './data/proxy.sqlite'): Promise<Knex> {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
  const db = makeKnex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.migrate.latest({ migrationSource, tableName: 'proxy_migrations' })
  return db
}

const json = (v: unknown): string | null => v === undefined || v === null ? null : JSON.stringify(v)
const parse = (v: string | null): any => v === null ? null : JSON.parse(v)

function toRecord (row: any): PaymentRequestRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    url: row.url,
    method: row.method,
    body: parse(row.body),
    purpose: row.purpose,
    priceSats: row.price_sats,
    serverKey: row.server_key,
    status: row.status,
    reason: row.reason,
    txid: row.txid,
    response: parse(row.response),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    paidAt: row.paid_at,
    eurRate: row.eur_rate ?? null,
    eurCents: row.eur_cents ?? null,
    rateSource: row.rate_source ?? null,
    rateAt: row.rate_at ?? null
  }
}

function toRow (r: Partial<PaymentRequestRecord>): Record<string, unknown> {
  const map: Record<string, [string, (v: any) => unknown]> = {
    id: ['id', v => v],
    agentId: ['agent_id', v => v],
    url: ['url', v => v],
    method: ['method', v => v],
    body: ['body', json],
    purpose: ['purpose', v => v],
    priceSats: ['price_sats', v => v],
    serverKey: ['server_key', v => v],
    status: ['status', v => v],
    reason: ['reason', v => v],
    txid: ['txid', v => v],
    response: ['response', json],
    createdAt: ['created_at', v => v],
    decidedAt: ['decided_at', v => v],
    decidedBy: ['decided_by', v => v],
    paidAt: ['paid_at', v => v],
    eurRate: ['eur_rate', v => v],
    eurCents: ['eur_cents', v => v],
    rateSource: ['rate_source', v => v],
    rateAt: ['rate_at', v => v]
  }
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) {
    if (v !== undefined && k in map) row[map[k][0]] = map[k][1](v)
  }
  return row
}

const toAgent = (row: any): Agent => ({ id: row.id, name: row.name, keyHint: row.key_hint, createdAt: row.created_at, status: row.status ?? 'active' })

export class ProxyStore {
  constructor (private readonly db: Knex) {}

  /** The same store, working inside `trx` (pair it with AuditLog.with(trx) to commit a change and its audit entry together). */
  with (trx: Knex.Transaction): ProxyStore {
    return new ProxyStore(trx)
  }

  /** Runs `fn` in one database transaction: everything it writes commits or rolls back together. */
  async transaction<T> (fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.db.transaction(fn)
  }

  async createAgent (agent: Agent, keyHash: string, rules: Rules = DEFAULT_RULES): Promise<void> {
    await this.db.transaction(async trx => {
      await trx('agents').insert({ id: agent.id, name: agent.name, key_hash: keyHash, key_hint: agent.keyHint, created_at: agent.createdAt, status: agent.status })
      await trx('rules').insert({ agent_id: agent.id, ...rulesRow(rules) })
    })
  }

  async findAgentByKeyHash (keyHash: string): Promise<Agent | undefined> {
    const row = await this.db('agents').where({ key_hash: keyHash }).first()
    return row === undefined ? undefined : toAgent(row)
  }

  /** Replaces the agent's API key (the old one stops working at once). */
  async replaceAgentKey (agentId: string, keyHash: string, keyHint: string): Promise<void> {
    await this.db('agents').where({ id: agentId }).update({ key_hash: keyHash, key_hint: keyHint })
  }

  /** A new connection code for the agent; its earlier unused codes are dropped. */
  async insertConnectCode (agentId: string, codeHash: string, expiresAt: number, now: number): Promise<void> {
    await this.db('connect_codes').where({ agent_id: agentId }).whereNull('used_at').delete()
    await this.db('connect_codes').insert({ code_hash: codeHash, agent_id: agentId, expires_at: expiresAt, created_at: now })
  }

  /** Drops the agent's unused codes (a disabled or deleted agent cannot connect). */
  async dropConnectCodes (agentId: string): Promise<number> {
    return await this.db('connect_codes').where({ agent_id: agentId }).whereNull('used_at').delete()
  }

  /** Codes that can still be used. */
  async activeConnectCodes (now: number): Promise<Array<{ codeHash: string, agentId: string }>> {
    const rows = await this.db('connect_codes').whereNull('used_at').where('expires_at', '>', now).select('code_hash', 'agent_id')
    return rows.map(r => ({ codeHash: r.code_hash, agentId: r.agent_id }))
  }

  /** Marks a code used; false if it was used (or dropped) in the meantime. */
  async useConnectCode (codeHash: string, now: number): Promise<boolean> {
    return await this.db('connect_codes').where({ code_hash: codeHash }).whereNull('used_at').update({ used_at: now }) === 1
  }

  async getAgent (id: string): Promise<Agent | undefined> {
    const row = await this.db('agents').where({ id }).first()
    return row === undefined ? undefined : toAgent(row)
  }

  /** Agents, oldest first; deleted ones only on request. */
  async listAgents (opts: { includeDeleted?: boolean } = {}): Promise<Agent[]> {
    const q = this.db('agents').orderBy('created_at', 'asc')
    if (opts.includeDeleted !== true) q.whereNot({ status: 'deleted' })
    return (await q).map(toAgent)
  }

  async setAgentStatus (agentId: string, status: AgentStatus, now: number): Promise<void> {
    await this.db('agents').where({ id: agentId }).update({ status, status_changed_at: now })
  }

  /** Requests still waiting for a decision or for execution. */
  async openRequests (agentId: string): Promise<PaymentRequestRecord[]> {
    return (await this.db('requests').where({ agent_id: agentId }).whereIn('status', ['pending', 'approved']).orderBy('created_at', 'asc')).map(toRecord)
  }

  /** Company money still locked for this agent: an open vault, and request vaults not spent or reclaimed. */
  async lockedFunds (agentId: string): Promise<{ vaultOpen: boolean, openRequestVaults: string[] }> {
    const vault = await this.db('vaults').where({ agent_id: agentId, status: 'open' }).first()
    const rvs = await this.db('request_vaults').where({ agent_id: agentId, status: 'open' }).select('request_id')
    return { vaultOpen: vault !== undefined, openRequestVaults: rvs.map(r => r.request_id as string) }
  }

  async getRules (agentId: string): Promise<Rules> {
    const row = await this.db('rules').where({ agent_id: agentId }).first()
    if (row === undefined) return DEFAULT_RULES
    if (row.currency === 'EUR') {
      return {
        allowedHosts: JSON.parse(row.allowed_hosts),
        currency: 'EUR',
        maxPerPaymentCents: Number(row.max_per_payment_cents ?? 0),
        dailyBudgetCents: Number(row.daily_budget_cents ?? 0),
        approvalThresholdCents: Number(row.approval_threshold_cents ?? 0)
      }
    }
    return {
      allowedHosts: JSON.parse(row.allowed_hosts),
      currency: 'SAT',
      maxPerPaymentSats: row.max_per_payment_sats,
      dailyBudgetSats: row.daily_budget_sats,
      approvalThresholdSats: row.approval_threshold_sats
    }
  }

  async setRules (agentId: string, rules: Rules): Promise<void> {
    await this.db('rules').insert({ agent_id: agentId, ...rulesRow(rules) }).onConflict('agent_id').merge()
  }

  async insertRequest (r: PaymentRequestRecord): Promise<PaymentRequestRecord> {
    await this.db('requests').insert(toRow(r))
    return r
  }

  async updateRequest (id: string, patch: Partial<PaymentRequestRecord>): Promise<PaymentRequestRecord> {
    await this.db('requests').where({ id }).update(toRow(patch))
    return (await this.getRequest(id))!
  }

  async getRequest (id: string): Promise<PaymentRequestRecord | undefined> {
    const row = await this.db('requests').where({ id }).first()
    return row === undefined ? undefined : toRecord(row)
  }

  async listRequests (filter: { status?: RequestStatus[] } = {}): Promise<Array<PaymentRequestRecord & { agentName: string }>> {
    const q = this.db('requests').join('agents', 'agents.id', 'requests.agent_id').select('requests.*', 'agents.name as agent_name')
    if (filter.status !== undefined) q.whereIn('requests.status', filter.status)
    const rows = await q.orderBy('requests.created_at', 'desc').limit(500)
    return rows.map(row => ({ ...toRecord(row), agentName: row.agent_name }))
  }

  /** Satoshis that left the wallet for this agent since `sinceMs`. */
  async spentSince (agentId: string, sinceMs: number): Promise<number> {
    const row = await this.db('requests')
      .where({ agent_id: agentId }).whereIn('status', SPENT_STATUSES).where('paid_at', '>=', sinceMs)
      .sum({ total: 'price_sats' }).first()
    return Number(row?.total ?? 0)
  }

  /**
   * Euro cents spent for this agent since `sinceMs`: the sum of the cents
   * recorded at payment time. Paid requests with no recorded cents (paid
   * under SAT rules before a switch to EUR) are returned as `unpricedSats`.
   */
  async spentCentsSince (agentId: string, sinceMs: number): Promise<{ cents: number, unpricedSats: number }> {
    const spent = (): Knex.QueryBuilder => this.db('requests').where({ agent_id: agentId }).whereIn('status', SPENT_STATUSES).where('paid_at', '>=', sinceMs)
    const priced = await spent().whereNotNull('eur_cents').sum({ total: 'eur_cents' }).first()
    const unpriced = await spent().whereNull('eur_cents').sum({ total: 'price_sats' }).first()
    return { cents: Number(priced?.total ?? 0), unpricedSats: Number(unpriced?.total ?? 0) }
  }

  /** Marks pending and approved requests that waited too long as expired. */
  /** Marks pending and approved requests that waited too long as expired; returns which ones. */
  async expireStale (nowMs: number, ttl: { pendingMs: number, approvedMs: number }): Promise<Array<{ id: string, agentId: string, was: 'pending' | 'approved' }>> {
    return await this.db.transaction(async trx => {
      const pending = await trx('requests').where({ status: 'pending' }).where('created_at', '<', nowMs - ttl.pendingMs).select('id', 'agent_id')
      const approved = await trx('requests').where({ status: 'approved' }).where('decided_at', '<', nowMs - ttl.approvedMs).select('id', 'agent_id')
      if (pending.length > 0) {
        await trx('requests').whereIn('id', pending.map(r => r.id))
          .update({ status: 'expired', reason: 'no decision in time', decided_at: nowMs, decided_by: 'system' })
      }
      if (approved.length > 0) {
        await trx('requests').whereIn('id', approved.map(r => r.id))
          .update({ status: 'expired', reason: 'approved but not executed in time', decided_by: 'system' })
      }
      return [
        ...pending.map(r => ({ id: r.id as string, agentId: r.agent_id as string, was: 'pending' as const })),
        ...approved.map(r => ({ id: r.id as string, agentId: r.agent_id as string, was: 'approved' as const }))
      ]
    })
  }
}

function rulesRow (rules: Rules): Record<string, unknown> {
  const hosts = JSON.stringify(rules.allowedHosts)
  if (isEur(rules)) {
    return {
      allowed_hosts: hosts,
      currency: 'EUR',
      max_per_payment_sats: 0,
      daily_budget_sats: 0,
      approval_threshold_sats: 0,
      max_per_payment_cents: rules.maxPerPaymentCents,
      daily_budget_cents: rules.dailyBudgetCents,
      approval_threshold_cents: rules.approvalThresholdCents
    }
  }
  return {
    allowed_hosts: hosts,
    currency: 'SAT',
    max_per_payment_sats: rules.maxPerPaymentSats,
    daily_budget_sats: rules.dailyBudgetSats,
    approval_threshold_sats: rules.approvalThresholdSats,
    max_per_payment_cents: null,
    daily_budget_cents: null,
    approval_threshold_cents: null
  }
}
