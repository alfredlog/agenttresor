/**
 * Proxy storage (knex + better-sqlite3). Migrations live in code and run on open.
 * API keys are stored as sha256 only.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import makeKnex, { type Knex } from 'knex'
import type { MerchantAnswer } from '../shared/merchant.js'
import { DEFAULT_RULES, type Rules } from './rules.js'

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'paid' | 'paid_not_delivered' | 'failed' | 'expired'
export const REQUEST_STATUSES: RequestStatus[] = ['pending', 'approved', 'denied', 'paid', 'paid_not_delivered', 'failed', 'expired']
/** Statuses whose satoshis have left the wallet: both count against the budget. */
export const SPENT_STATUSES: RequestStatus[] = ['paid', 'paid_not_delivered']

export interface Agent {
  id: string
  name: string
  keyHint: string
  createdAt: number
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
    paidAt: row.paid_at
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
    paidAt: ['paid_at', v => v]
  }
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) {
    if (v !== undefined && k in map) row[map[k][0]] = map[k][1](v)
  }
  return row
}

const toAgent = (row: any): Agent => ({ id: row.id, name: row.name, keyHint: row.key_hint, createdAt: row.created_at })

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
      await trx('agents').insert({ id: agent.id, name: agent.name, key_hash: keyHash, key_hint: agent.keyHint, created_at: agent.createdAt })
      await trx('rules').insert({ agent_id: agent.id, ...rulesRow(rules) })
    })
  }

  async findAgentByKeyHash (keyHash: string): Promise<Agent | undefined> {
    const row = await this.db('agents').where({ key_hash: keyHash }).first()
    return row === undefined ? undefined : toAgent(row)
  }

  async getAgent (id: string): Promise<Agent | undefined> {
    const row = await this.db('agents').where({ id }).first()
    return row === undefined ? undefined : toAgent(row)
  }

  async listAgents (): Promise<Agent[]> {
    return (await this.db('agents').orderBy('created_at', 'asc')).map(toAgent)
  }

  async getRules (agentId: string): Promise<Rules> {
    const row = await this.db('rules').where({ agent_id: agentId }).first()
    if (row === undefined) return DEFAULT_RULES
    return {
      allowedHosts: JSON.parse(row.allowed_hosts),
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
  return {
    allowed_hosts: JSON.stringify(rules.allowedHosts),
    max_per_payment_sats: rules.maxPerPaymentSats,
    daily_budget_sats: rules.dailyBudgetSats,
    approval_threshold_sats: rules.approvalThresholdSats
  }
}
