/**
 * Audit log integrity: a state change and its audit entry commit together,
 * the dashboard's verify is incremental (with a full re-check on demand), and
 * deleting the newest entries after an anchor is reported. Mock chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrivateKey, Transaction, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { anchorAuditHead } from '../src/company/audit-client'
import { getApproval } from '../src/company/vault-client'
import { vaultLockingScript } from '../src/vault/script'
import { createMerchantApp } from '../src/merchant/app'
import { ADMIN_TOKEN, createProxyHarness, type ProxyHarness, type TestAgent } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string

const rules = (extra: object = {}): object => ({ allowedHosts: [new URL(merchant).host], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000, ...extra })
const count = async (table: string, where: object = {}): Promise<number> => Number((await h.db(table).where(where).count({ n: '*' }).first())?.n)
const head = async (): Promise<any> => (await h.admin('/admin/audit/head')).body
const verify = async (full = false): Promise<any> => (await h.admin(`/admin/audit/verify${full ? '?full=1' : ''}`)).body

/** Every insert into audit_log fails while this trigger exists. */
const auditDown = async (): Promise<void> => { await h.db.raw("CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END") }
const auditUp = async (): Promise<void> => { await h.db.raw('DROP TRIGGER IF EXISTS audit_down') }

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
})
afterAll(async () => { await h?.close() })

describe('a state change and its audit entry commit together', () => {
  let agent: TestAgent
  let pendingId: string
  let keyless: { id: string, apiKey: string }
  beforeAll(async () => {
    agent = await h.createAgent('atomic-bot', rules(), 10_000)
    keyless = await h.newAgent('keyless-bot')
    pendingId = (await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel' })).body.requestId
  })

  it('if the audit entry cannot be written, nothing is changed', async () => {
    const before = {
      agents: await count('agents'),
      requests: await count('requests'),
      rules: await h.db('rules').where({ agent_id: agent.id }).first(),
      vault: await h.db('vaults').where({ agent_id: agent.id }).first(),
      audit: (await head()).seq
    }
    await auditDown()
    try {
      // Agent created / rules changed (admin).
      expect((await h.admin('/admin/agents', { method: 'POST', body: { name: 'never-created' } })).status).toBe(500)
      expect((await h.admin(`/admin/agents/${agent.id}/rules`, { method: 'PUT', body: rules({ dailyBudgetSats: 1 }) })).status).toBe(500)
      // A payment request (created + decided by the rules).
      expect((await h.pay(agent, { url: `${merchant}/api/report`, purpose: 'Report' })).status).toBe(500)
      // A denial by the admin.
      expect((await h.admin(`/admin/requests/${pendingId}/deny`, { method: 'POST', body: { reason: 'no' } })).status).toBe(500)
      // An agent key registration.
      expect((await h.call('/v1/vault/agent-key', keyless.apiKey, { method: 'POST', body: { publicKey: PrivateKey.fromRandom().toPublicKey().toString() } })).status).toBe(500)
    } finally {
      await auditUp()
    }
    expect(await count('agents')).toBe(before.agents)
    expect(await count('requests')).toBe(before.requests)
    expect(await h.db('rules').where({ agent_id: agent.id }).first()).toEqual(before.rules)
    expect(await h.db('vaults').where({ agent_id: agent.id }).first()).toEqual(before.vault)
    expect(await h.db('vaults').where({ agent_id: keyless.id }).first()).toBeUndefined()
    expect((await h.call(`/v1/requests/${pendingId}`, agent.key)).body.status).toBe('pending')
    expect((await head()).seq).toBe(before.audit)
    expect((await verify(true)).ok).toBe(true)
  })

  it('a funded approval is rolled back with its entry, and can be posted again', async () => {
    // The company funds the request vault by hand, so the same transaction can be posted twice.
    const a = await getApproval(h.url, ADMIN_TOKEN, pendingId)
    const { publicKey: companyPub } = await h.company.getPublicKey({ protocolID: a.protocolID, keyID: a.keyID, counterparty: 'self' })
    const lockingScript = vaultLockingScript({ agentPub: a.agentPub, policyPub: a.policyPub, companyPub }).toHex()
    const created = await h.company.createAction({
      description: 'Approve, audit down',
      outputs: [{ lockingScript, satoshis: a.totalSats, outputDescription: 'request vault' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const vout = Transaction.fromAtomicBEEF(created.tx!).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
    const body = { beef: Utils.toHex(created.tx!), vout, companyPub }

    await auditDown()
    try {
      expect((await h.admin(`/admin/requests/${pendingId}/approve`, { method: 'POST', body })).status).toBe(500)
    } finally {
      await auditUp()
    }
    expect((await h.call(`/v1/requests/${pendingId}`, agent.key)).body.status).toBe('pending')
    expect(await count('request_vaults', { request_id: pendingId })).toBe(0)

    // Nothing was half-written, so the same funding goes through now, with both audit entries.
    expect((await h.admin(`/admin/requests/${pendingId}/approve`, { method: 'POST', body })).status).toBe(200)
    expect(await count('request_vaults', { request_id: pendingId })).toBe(1)
    const last = (await h.admin('/admin/audit?limit=2')).body.entries.map((e: any) => e.type)
    expect(last).toEqual(['request_vault.funded', 'request.decided'])
  })

  it('an anchor is not recorded without its entry', async () => {
    await auditDown()
    try {
      await expect(anchorAuditHead(h.company, h.url, ADMIN_TOKEN)).rejects.toThrow()
    } finally {
      await auditUp()
    }
    expect(await count('audit_anchors')).toBe(0)
  })
})

describe('incremental verify', () => {
  it('re-checks only the new entries, until something it already checked changes', async () => {
    const full = await verify(true)
    expect(full).toMatchObject({ ok: true, mode: 'full', verifiedThrough: full.entries })
    expect(full.checked).toBe(full.entries)

    await h.admin('/admin/agents', { method: 'POST', body: { name: 'incremental-bot' } })
    const inc = await verify()
    // Creating an agent logs two entries: created, and its connection code issued.
    expect(inc).toMatchObject({ ok: true, mode: 'incremental', checked: 2, verifiedThrough: full.entries + 2 })
    expect((await verify()).checked).toBe(0)

    // An old entry is edited: the incremental check does not re-hash it, the full one finds it.
    const row = await h.db('audit_log').where({ seq: 2 }).first()
    await h.db('audit_log').where({ seq: 2 }).update({ actor: 'company' })
    try {
      expect((await verify()).mode).toBe('incremental')
      expect(await verify(true)).toMatchObject({ ok: false, mode: 'full', brokenAt: 2 })
      // After a failure there is no verified mark: the next default run checks everything again.
      expect(await verify()).toMatchObject({ ok: false, mode: 'full', brokenAt: 2, verifiedThrough: 0 })
    } finally {
      await h.db('audit_log').where({ seq: 2 }).update({ actor: row.actor })
    }
    expect(await verify()).toMatchObject({ ok: true, mode: 'full' })

    // The last verified entry itself is changed: the mark no longer matches, so the run falls back to full.
    const { seq } = await head()
    const last = await h.db('audit_log').where({ seq }).first()
    await h.db('audit_log').where({ seq }).update({ hash: 'ff'.repeat(32) })
    try {
      expect(await verify()).toMatchObject({ ok: false, mode: 'full', brokenAt: seq })
    } finally {
      await h.db('audit_log').where({ seq }).update({ hash: last.hash })
    }
    expect((await verify()).ok).toBe(true)
  })
})

describe('anchors and the tail of the log', () => {
  it('counts the entries no anchor covers yet', async () => {
    const before = await head()
    expect(before).toMatchObject({ latestAnchorSeq: null, unanchoredEntries: before.seq, chainShorterThanAnchor: false })

    const anchored = await anchorAuditHead(h.company, h.url, ADMIN_TOKEN)
    // The anchor's own record does not count as unanchored.
    expect(await head()).toMatchObject({ seq: anchored.seq + 1, latestAnchorSeq: anchored.seq, unanchoredEntries: 0, chainShorterThanAnchor: false })

    await h.admin('/admin/agents', { method: 'POST', body: { name: 'after-anchor-1' } })
    await h.admin('/admin/agents', { method: 'POST', body: { name: 'after-anchor-2' } })
    expect((await head()).unanchoredEntries).toBe(4) // two agents, two entries each
  })

  it('reports a log shorter than its latest anchor: the newest entries were deleted', async () => {
    const { latestAnchorSeq } = await head()
    expect((await verify(true)).ok).toBe(true)
    // Someone deletes the anchored entry and everything after it: the remaining chain is still consistent.
    await h.db('audit_log').where('seq', '>=', latestAnchorSeq).delete()

    expect(await head()).toMatchObject({ seq: latestAnchorSeq - 1, chainShorterThanAnchor: true })
    const v = await verify()
    expect(v).toMatchObject({ ok: false, chainShorterThanAnchor: true, brokenAt: latestAnchorSeq })
    expect(v.reason).toMatch(/newest entries were deleted/)
    expect(v.anchors.find((a: any) => a.seq === latestAnchorSeq).matches).toBe(false)
    expect((await verify(true)).ok).toBe(false)
  })
})
