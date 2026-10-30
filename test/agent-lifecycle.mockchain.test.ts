/**
 * Disabling, enabling and deleting agents from the admin API. A disabled agent
 * loses its key and codes and its open requests are denied; a deleted agent
 * disappears from the list but its history (requests, ledger, audit) stays.
 * Mock chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Wallet } from '@bsv/wallet-toolbox'
import { approveAndFund, reclaimRequestVault, reclaimVault } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { ADMIN_TOKEN, createProxyHarness, fp, type ProxyHarness, type TestAgent } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string

const rules = (): object => ({ allowedHosts: [new URL(merchant).host], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000 })
const report = (): object => ({ url: `${merchant}/api/report`, purpose: 'Market report' })
const hotel = (): object => ({ url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel' })
const exchange = async (code: string): Promise<{ status: number, body: any }> => await h.call('/v1/connect', undefined, { method: 'POST', body: { code } })
const listed = async (deleted = false): Promise<any[]> => (await h.admin(`/admin/agents${deleted ? '?deleted=1' : ''}`)).body.agents
const auditOf = async (agentId: string): Promise<any[]> =>
  (await h.admin('/admin/audit?limit=1000')).body.entries.filter((e: any) => e.data.agentId === agentId)

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
})
afterAll(async () => { await h?.close() })

describe('disable, enable, delete', () => {
  let agent: TestAgent
  let paidId: string, pendingId: string, approvedId: string

  beforeAll(async () => {
    agent = await h.createAgent('lifecycle-bot', rules(), 10_000)
    const paid = await h.payAndSign(agent, report(), REPORT_PRICE_SATS)
    expect(paid.body.status).toBe('paid')
    paidId = paid.body.requestId
    pendingId = (await h.pay(agent, hotel())).body.requestId
    approvedId = (await h.pay(agent, hotel())).body.requestId
    // The company approves the second one by funding a request vault for it.
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, approvedId, fp(agent))
    expect((await h.call(`/v1/requests/${approvedId}`, agent.key)).body.status).toBe('approved')
  })

  it('disable: the key gets 401, the connection code is revoked, open requests are denied', async () => {
    // A code issued before the disable (with an open vault the current key keeps working until it is used).
    const code = (await h.admin(`/admin/agents/${agent.id}/connect-code`, { method: 'POST' })).body.connectCode
    expect((await h.call('/v1/budget', agent.key)).status).toBe(200)

    const r = await h.admin(`/admin/agents/${agent.id}/disable`, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: agent.id, status: 'disabled' })
    expect(r.body.deniedRequests.sort()).toEqual([pendingId, approvedId].sort())

    expect((await h.call('/v1/budget', agent.key)).status).toBe(401)
    expect((await h.pay(agent, report())).status).toBe(401)
    expect((await exchange(code)).status).toBe(401)
    expect(await h.db('connect_codes').where({ agent_id: agent.id }).whereNull('used_at').count({ n: '*' }).first()).toEqual({ n: 0 })

    for (const id of [pendingId, approvedId]) {
      expect(await h.db('requests').where({ id }).first()).toMatchObject({ status: 'denied', reason: 'agent disabled', decided_by: 'admin' })
    }
    expect((await listed()).find(a => a.id === agent.id)).toMatchObject({ status: 'disabled', key: null, connected: false })

    const entry = (await auditOf(agent.id)).at(-1)
    expect(entry).toMatchObject({ actor: 'admin', type: 'agent.disabled', data: { agentId: agent.id, name: 'lifecycle-bot', keyRevoked: true, connectCodesRevoked: 1 } })
    expect(JSON.stringify(entry)).not.toMatch(/agt_|AT-/)

    // No new code while disabled, and no second disable.
    expect((await h.admin(`/admin/agents/${agent.id}/connect-code`, { method: 'POST' })).status).toBe(409)
    expect((await h.admin(`/admin/agents/${agent.id}/disable`, { method: 'POST' })).status).toBe(409)
  })

  it('enable issues a new connection code; the old key stays revoked', async () => {
    const r = await h.admin(`/admin/agents/${agent.id}/enable`, { method: 'POST' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ id: agent.id, status: 'active', connectCode: expect.stringMatching(/^AT-/) })
    expect((await h.call('/v1/budget', agent.key)).status).toBe(401)

    const connected = await exchange(r.body.connectCode)
    expect(connected.status).toBe(200)
    expect((await h.call('/v1/budget', connected.body.apiKey)).status).toBe(200)
    agent = { ...agent, key: connected.body.apiKey }
    expect((await auditOf(agent.id)).map(e => e.type).slice(-3)).toEqual(['agent.enabled', 'agent.connect_code_issued', 'agent.connected'])
    expect((await h.admin(`/admin/agents/${agent.id}/enable`, { method: 'POST' })).status).toBe(409)
  })

  it('delete is refused while its vault or a request vault is open, allowed after reclaim', async () => {
    const refused = await h.admin(`/admin/agents/${agent.id}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: 'FUNDS_LOCKED', vaultOpen: true, openRequestVaults: [approvedId] })
    expect(refused.body.error).toMatch(/reclaim its vault first/)

    await reclaimVault(h.company, h.url, ADMIN_TOKEN, agent.id)
    const stillLocked = await h.admin(`/admin/agents/${agent.id}`, { method: 'DELETE' })
    expect(stillLocked.status).toBe(409)
    expect(stillLocked.body).toMatchObject({ vaultOpen: false, openRequestVaults: [approvedId] })

    // The approved request was denied on disable, so its funds can be taken back.
    await reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, approvedId)
    const deleted = await h.admin(`/admin/agents/${agent.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({ id: agent.id, status: 'deleted' })
    expect((await h.call('/v1/budget', agent.key)).status).toBe(401)
  })

  it('a deleted agent is hidden, but its requests, ledger and audit entries are kept', async () => {
    expect((await listed()).map(a => a.id)).not.toContain(agent.id)
    expect((await listed(true)).find(a => a.id === agent.id)).toMatchObject({ status: 'deleted', name: 'lifecycle-bot' })

    const ledger = (await h.admin('/admin/ledger')).body.entries
    expect(ledger.find((e: any) => e.requestId === paidId)).toMatchObject({ agentId: agent.id, agentName: 'lifecycle-bot', status: 'paid', satoshis: REPORT_PRICE_SATS })
    const requests = (await h.admin('/admin/requests')).body.requests.filter((r: any) => r.agentId === agent.id)
    expect(requests.map((r: any) => r.requestId).sort()).toEqual([paidId, pendingId, approvedId].sort())

    const types = (await auditOf(agent.id)).map(e => e.type)
    for (const t of ['agent.created', 'request.paid', 'request_vault.funded', 'agent.disabled', 'agent.enabled', 'agent.deleted']) expect(types).toContain(t)
    expect((await auditOf(agent.id)).at(-1)).toMatchObject({ actor: 'admin', type: 'agent.deleted', data: { agentId: agent.id, was: 'active' } })
    expect((await h.admin('/admin/audit/verify?full=1')).body.ok).toBe(true)
    expect(await h.db('agents').where({ id: agent.id }).first()).toMatchObject({ status: 'deleted' })
  })

  it('a deleted agent cannot be used, enabled or changed again', async () => {
    for (const [path, method] of [
      [`/admin/agents/${agent.id}/enable`, 'POST'], [`/admin/agents/${agent.id}/disable`, 'POST'], [`/admin/agents/${agent.id}`, 'DELETE'],
      [`/admin/agents/${agent.id}/connect-code`, 'POST'], [`/admin/vaults/${agent.id}/params`, 'GET']
    ] as const) {
      expect((await h.admin(path, { method })).status).toBe(404)
    }
    expect((await h.admin(`/admin/agents/${agent.id}/rules`, { method: 'PUT', body: rules() })).status).toBe(404)
  })
})

describe('simple cases', () => {
  it('an agent that never had a vault can be deleted right away; its pending request is denied', async () => {
    const created = await h.newAgent('short-lived', rules())
    const pending = await h.call('/v1/pay', created.apiKey, { method: 'POST', body: hotel() })
    expect(pending.body).toMatchObject({ status: 'pending', satoshis: ROOM_RATES_SATS.standard })
    const r = await h.admin(`/admin/agents/${created.id}`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect(r.body.deniedRequests).toEqual([pending.body.requestId])
    expect((await h.call('/v1/budget', created.apiKey)).status).toBe(401)
    expect(await h.db('requests').where({ id: pending.body.requestId }).first()).toMatchObject({ status: 'denied', reason: 'agent deleted' })
  })

  it('a code issued at creation cannot be used once the agent is disabled', async () => {
    const created = (await h.admin('/admin/agents', { method: 'POST', body: { name: 'never-connected', rules: rules() } })).body
    expect((await h.admin(`/admin/agents/${created.id}/disable`, { method: 'POST' })).status).toBe(200)
    expect((await exchange(created.connectCode)).status).toBe(401)
  })

  it('an unknown agent is a 404', async () => {
    expect((await h.admin('/admin/agents/A-00000000/disable', { method: 'POST' })).status).toBe(404)
    expect((await h.admin('/admin/agents/A-00000000', { method: 'DELETE' })).status).toBe(404)
  })
})
