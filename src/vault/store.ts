/** Vault storage, in the proxy database (tables from migration 002_vaults). */
import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'

export type VaultStatus = 'awaiting_funding' | 'open' | 'closed'

export interface Vault {
  agentId: string
  agentPub: string
  companyPub: string | null
  lockingScript: string | null
  status: VaultStatus
  txid: string | null
  vout: number | null
  satoshis: number | null
  /** BEEF (hex) holding the current UTXO's transaction and its ancestry. */
  beefHex: string | null
  createdAt: number
  updatedAt: number
}

export type VaultTxKind = 'fund' | 'payment' | 'reclaim'
export type VaultTxStatus = 'awaiting_signature' | 'broadcast' | 'expired' | 'failed' | 'done'

export interface VaultTx {
  id: string
  agentId: string
  requestId: string | null
  kind: VaultTxKind
  status: VaultTxStatus
  txid: string | null
  inputOutpoint: string | null
  unsignedTx: string | null
  priceSats: number | null
  feeSats: number | null
  changeSats: number | null
  serverKey: string | null
  nonce: string | null
  timeMs: string | null
  reason: string | null
  createdAt: number
  updatedAt: number
}

const toVault = (r: any): Vault => ({
  agentId: r.agent_id,
  agentPub: r.agent_pub,
  companyPub: r.company_pub,
  lockingScript: r.locking_script,
  status: r.status,
  txid: r.txid,
  vout: r.vout,
  satoshis: r.satoshis,
  beefHex: r.beef,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toVaultTx = (r: any): VaultTx => ({
  id: r.id,
  agentId: r.agent_id,
  requestId: r.request_id,
  kind: r.kind,
  status: r.status,
  txid: r.txid,
  inputOutpoint: r.input_outpoint,
  unsignedTx: r.unsigned_tx,
  priceSats: r.price_sats,
  feeSats: r.fee_sats,
  changeSats: r.change_sats,
  serverKey: r.server_key,
  nonce: r.nonce,
  timeMs: r.time_ms,
  reason: r.reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const snake = (k: string): string => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const COLUMN: Record<string, string> = { beefHex: 'beef' }
function toRow (patch: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[COLUMN[k] ?? snake(k)] = v
  return row
}

export class VaultStore {
  constructor (private readonly db: Knex) {}

  async getVault (agentId: string): Promise<Vault | undefined> {
    const row = await this.db('vaults').where({ agent_id: agentId }).first()
    return row === undefined ? undefined : toVault(row)
  }

  async listVaults (): Promise<Array<Vault & { agentName: string }>> {
    const rows = await this.db('vaults').join('agents', 'agents.id', 'vaults.agent_id').select('vaults.*', 'agents.name as agent_name').orderBy('vaults.created_at', 'asc')
    return rows.map(r => ({ ...toVault(r), agentName: r.agent_name }))
  }

  /** Registers (or replaces, while not funded) the agent's public key. */
  async setAgentKey (agentId: string, agentPub: string, now: number): Promise<void> {
    await this.db('vaults')
      .insert({ agent_id: agentId, agent_pub: agentPub, status: 'awaiting_funding', created_at: now, updated_at: now })
      .onConflict('agent_id').merge({ agent_pub: agentPub, status: 'awaiting_funding', updated_at: now })
  }

  async updateVault (agentId: string, patch: Partial<Omit<Vault, 'agentId'>>): Promise<Vault> {
    await this.db('vaults').where({ agent_id: agentId }).update(toRow(patch))
    return (await this.getVault(agentId))!
  }

  async insertTx (tx: Omit<VaultTx, 'id'>): Promise<VaultTx> {
    const id = `V-${randomBytes(5).toString('hex').toUpperCase()}`
    await this.db('vault_txs').insert(toRow({ id, ...tx }))
    return { id, ...tx }
  }

  async updateTx (id: string, patch: Partial<Omit<VaultTx, 'id'>>): Promise<void> {
    await this.db('vault_txs').where({ id }).update(toRow(patch))
  }

  async awaitingSignature (agentId: string): Promise<VaultTx[]> {
    return (await this.db('vault_txs').where({ agent_id: agentId, status: 'awaiting_signature' })).map(toVaultTx)
  }

  async listTxs (agentId: string): Promise<VaultTx[]> {
    return (await this.db('vault_txs').where({ agent_id: agentId }).orderBy('created_at', 'asc')).map(toVaultTx)
  }
}
