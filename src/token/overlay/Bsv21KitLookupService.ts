import type { LookupFormula, LookupService, OutputAdmittedByTopic, OutputSpent } from '@bsv/overlay'
import { Utils, type LookupQuestion } from '../../shared/bsv.js'
import type { Knex } from 'knex'
import { decodeBsv21, tokenIdFromOutpoint } from '../inscription'
import { GAP_LIMIT, receivePkh } from '../addresses'
import { TOPIC } from './Bsv21KitTopicManager'

export const SERVICE = 'ls_tokenkit'
const OUTPUTS = 'bsv21kit_outputs'
const TOKENS = 'bsv21kit_tokens'
const MAX_RESULTS = 500

/** Queries accepted by `ls_tokenkit` (the `query` of a LookupQuestion). */
export type KitQuery =
  | { op: 'token', tokenId: string }
  | { op: 'tokens' }
  | { op: 'utxos', ownerPkhs: string[], tokenId?: string }
  | { op: 'identity', identityKey: string, tokenId?: string, includeSpent?: boolean }
  | { op: 'outpoint', txid: string, vout: number }
  | { op: 'history', tokenId: string, limit?: number }

/** Per-output metadata returned in each lookup answer's `context` (UTF-8 JSON). */
export interface OutputContext {
  tokenId: string
  op: string
  amt: string
  ownerPkh: string
  spent: boolean
  spendingTxid?: string
  /** Receive-key index, only for `identity` queries. */
  index?: number
  sym?: string
  dec?: string
}

interface OutputRow {
  txid: string
  vout: number
  token_id: string
  op: string
  amt: string
  owner_pkh: string
  spent: number
  spending_txid: string | null
}

export const migrations = [{
  name: '2026-10-17-001-bsv21kit',
  async up (knex: Knex): Promise<void> {
    await knex.schema.createTable(OUTPUTS, t => {
      t.string('txid', 64).notNullable()
      t.integer('vout').notNullable()
      t.string('token_id', 80).notNullable().index()
      t.string('op', 16).notNullable()
      t.string('amt', 24).notNullable()
      t.string('owner_pkh', 40).notNullable().index()
      t.integer('satoshis').notNullable()
      t.boolean('spent').notNullable().defaultTo(false)
      t.string('spending_txid', 64)
      t.timestamp('created_at').defaultTo(knex.fn.now())
      t.primary(['txid', 'vout'])
    })
    await knex.schema.createTable(TOKENS, t => {
      t.string('token_id', 80).primary()
      t.string('sym', 64)
      t.string('dec', 4)
      t.string('icon', 255)
      t.string('supply', 24).notNullable()
      t.timestamp('created_at').defaultTo(knex.fn.now())
    })
  },
  async down (knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists(OUTPUTS)
    await knex.schema.dropTableIfExists(TOKENS)
  }
}]

const isHex = (s: unknown, len: number): s is string => typeof s === 'string' && s.length === len && /^[0-9a-f]+$/.test(s)

export class Bsv21KitLookupService implements LookupService {
  readonly admissionMode = 'locking-script' as const
  readonly spendNotificationMode = 'txid' as const

  constructor (private readonly knex: Knex) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script' || payload.topic !== TOPIC) return
    const d = decodeBsv21(payload.lockingScript)
    if (d === null) return
    const tokenId = d.op === 'deploy+mint' ? tokenIdFromOutpoint(payload.txid, payload.outputIndex) : d.id!
    await this.knex(OUTPUTS).insert({
      txid: payload.txid,
      vout: payload.outputIndex,
      token_id: tokenId,
      op: d.op,
      amt: d.amt,
      owner_pkh: d.ownerPkh,
      satoshis: payload.satoshis
    }).onConflict(['txid', 'vout']).ignore()
    if (d.op === 'deploy+mint') {
      await this.knex(TOKENS).insert({ token_id: tokenId, sym: d.sym ?? null, dec: d.dec ?? '0', icon: d.icon ?? null, supply: d.amt })
        .onConflict('token_id').ignore()
    }
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== TOPIC) return
    const spendingTxid = payload.mode === 'txid' || payload.mode === 'script' ? payload.spendingTxid : null
    await this.knex(OUTPUTS).where({ txid: payload.txid, vout: payload.outputIndex }).update({ spent: true, spending_txid: spendingTxid })
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.knex(OUTPUTS).where({ txid, vout: outputIndex }).delete()
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    if (question.service !== SERVICE) throw new Error(`unsupported service ${question.service}`)
    const q = question.query as KitQuery
    if (q === null || typeof q !== 'object') throw new Error('query must be an object')

    switch (q.op) {
      case 'token': {
        const [txid, vout] = this.parseTokenId(q.tokenId)
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ txid, vout }))
      }
      case 'tokens':
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ op: 'deploy+mint' }).orderBy('created_at', 'desc').limit(MAX_RESULTS))
      case 'utxos': {
        if (!Array.isArray(q.ownerPkhs) || q.ownerPkhs.length === 0 || q.ownerPkhs.length > MAX_RESULTS || !q.ownerPkhs.every(p => isHex(p, 40))) {
          throw new Error('ownerPkhs must be 1..500 hex pkhs')
        }
        const rows = this.knex<OutputRow>(OUTPUTS).whereIn('owner_pkh', q.ownerPkhs).andWhere('spent', false)
        if (q.tokenId !== undefined) rows.andWhere({ token_id: q.tokenId })
        return await this.formula(await rows.limit(MAX_RESULTS))
      }
      case 'identity': {
        if (!isHex(q.identityKey, 66)) throw new Error('identityKey must be a compressed public key (hex)')
        const indexOf = await this.scanIdentity(q.identityKey)
        if (indexOf.size === 0) return []
        const rows = this.knex<OutputRow>(OUTPUTS).whereIn('owner_pkh', [...indexOf.keys()])
        if (q.includeSpent !== true) rows.andWhere('spent', false)
        if (q.tokenId !== undefined) rows.andWhere({ token_id: q.tokenId })
        return await this.formula(await rows.limit(MAX_RESULTS), indexOf)
      }
      case 'outpoint':
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ txid: q.txid, vout: q.vout }))
      case 'history': {
        const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_RESULTS)
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ token_id: q.tokenId }).orderBy('created_at', 'desc').limit(limit))
      }
      default:
        throw new Error('unknown query op')
    }
  }

  /** pkh → receive index for every used index of `identityKey`, scanning GAP_LIMIT past the last used one. */
  private async scanIdentity (identityKey: string): Promise<Map<string, number>> {
    const used = new Map<string, number>()
    let start = 0
    for (;;) {
      const batch = new Map<string, number>()
      for (let i = start; i < start + GAP_LIMIT; i++) batch.set(receivePkh(identityKey, i), i)
      const hits = await this.knex(OUTPUTS).distinct('owner_pkh').whereIn('owner_pkh', [...batch.keys()])
      if (hits.length === 0) return used
      let maxUsed = start
      for (const { owner_pkh: pkh } of hits) {
        const i = batch.get(pkh)!
        used.set(pkh, i)
        maxUsed = Math.max(maxUsed, i)
      }
      start = maxUsed + 1
    }
  }

  private parseTokenId (tokenId: string): [string, number] {
    const m = /^([0-9a-f]{64})_(\d+)$/.exec(tokenId ?? '')
    if (m === null) throw new Error('tokenId must be "<txid>_<vout>"')
    return [m[1], Number(m[2])]
  }

  private async formula (rows: OutputRow[], indexOf?: Map<string, number>): Promise<LookupFormula> {
    const tokenIds = [...new Set(rows.map(r => r.token_id))]
    const meta = new Map((await this.knex(TOKENS).whereIn('token_id', tokenIds)).map((t: any) => [t.token_id, t]))
    return rows.map(r => {
      const ctx: OutputContext = {
        tokenId: r.token_id,
        op: r.op,
        amt: r.amt,
        ownerPkh: r.owner_pkh,
        spent: Boolean(r.spent),
        ...(r.spending_txid !== null ? { spendingTxid: r.spending_txid } : {}),
        ...(indexOf?.has(r.owner_pkh) === true ? { index: indexOf.get(r.owner_pkh) } : {}),
        ...(meta.get(r.token_id)?.sym != null ? { sym: meta.get(r.token_id).sym } : {}),
        ...(meta.get(r.token_id)?.dec != null ? { dec: meta.get(r.token_id).dec } : {})
      }
      return { txid: r.txid, outputIndex: r.vout, context: Utils.toArray(JSON.stringify(ctx), 'utf8') }
    })
  }

  async getDocumentation (): Promise<string> {
    return '# ls_tokenkit\nQueries: token, tokens, utxos (ownerPkhs), identity (identityKey), outpoint, history.'
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return { name: SERVICE, shortDescription: 'BSV-21 token UTXOs by owner, identity key, token and outpoint' }
  }
}

export const createBsv21KitLookupService = (knex: Knex): { service: LookupService, migrations: typeof migrations } => ({
  service: new Bsv21KitLookupService(knex),
  migrations
})
