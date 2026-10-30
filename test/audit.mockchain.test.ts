/**
 * Tamper-evident audit log: a hash chain over every decision and payment,
 * anchored on BSV by the company's own wallet (OP_RETURN). Mock chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { anchorLockingScript, parseAnchorScript } from '../src/audit/anchor-script'
import { assertNoSecrets, AuditLog, canonicalJson, entryHash, GENESIS_HASH, verifyChain, type AuditEntry } from '../src/audit/log'
import { verifyDatabase } from '../src/audit/verify-db'
import { anchorAuditHead } from '../src/company/audit-client'
import { approveAndFund } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { openProxyDb } from '../src/proxy/store'
import { ADMIN_TOKEN, createProxyHarness, fp, type ProxyHarness, type TestAgent } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string
const agents: TestAgent[] = []

const rules = (): object => ({ allowedHosts: [new URL(merchant).host], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000 })
const entries = async (): Promise<AuditEntry[]> => await new AuditLog(h.db).all()
const ofAgent = async (agentId: string): Promise<Array<[string, string]>> =>
  (await entries()).filter(e => e.data.agentId === agentId).map(e => [e.actor, e.type])
const head = async (): Promise<{ seq: number, hash: string }> => (await h.admin('/admin/audit/head')).body
const verify = async (): Promise<any> => (await h.admin('/admin/audit/verify?full=1')).body
const newAgent = async (name: string, vaultSats = 0): Promise<TestAgent> => {
  const a = await h.createAgent(name, rules(), vaultSats)
  agents.push(a)
  return a
}

/** The company's wallet makes a transaction with this one output and posts it as an anchor. */
async function postAnchor (lockingScript: string, satoshis: number): Promise<{ status: number, body: any }> {
  const created = await h.company.createAction({
    description: 'Anchor test',
    outputs: [{ lockingScript, satoshis, outputDescription: 'anchor test' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  return await h.admin('/admin/audit/anchors', { method: 'POST', body: { beef: Utils.toHex(created.tx!) } })
}

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
})
afterAll(async () => { await h?.close() })

describe('hash chain', () => {
  it('canonical JSON sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}')
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }))
  })

  it('links each entry to the previous one, from 64 zeros', () => {
    const e1 = { seq: 1, at: 1, actor: 'admin', type: 'agent.created', data: { agentId: 'A-1' }, prevHash: GENESIS_HASH, hash: '' }
    e1.hash = entryHash(GENESIS_HASH, e1)
    const e2 = { seq: 2, at: 2, actor: 'rules', type: 'request.decided', data: { requestId: 'R-1' }, prevHash: e1.hash, hash: '' }
    e2.hash = entryHash(e1.hash, e2)
    expect(verifyChain([e1, e2])).toEqual({ ok: true, entries: 2 })
    expect(verifyChain([e1, { ...e2, data: { requestId: 'R-2' } }])).toMatchObject({ ok: false, brokenAt: 2 })
    expect(verifyChain([e2], GENESIS_HASH)).toMatchObject({ ok: false, brokenAt: 2 }) // entry 1 removed
  })

  it('refuses to log anything that looks like a secret', () => {
    expect(() => { assertNoSecrets({ note: `key agt_${'ab'.repeat(32)}` }) }).toThrow(/agent API key/)
    expect(() => { assertNoSecrets({ nested: { privateKey: 'x' } }) }).toThrow(/secret/)
    expect(() => { assertNoSecrets({ adminToken: 'x' }) }).toThrow(/secret/)
    expect(() => { assertNoSecrets({ keyHint: 'agt_ab12…', agentPub: '02'.padEnd(66, 'a') }) }).not.toThrow()
  })

  it('grows on each event', async () => {
    const start = (await head()).seq
    const created = await h.admin('/admin/agents', { method: 'POST', body: { name: 'audit-bot', rules: rules() } })
    expect((await head()).seq).toBe(start + 2) // created, and its connection code issued
    const connected = await h.call('/v1/connect', undefined, { method: 'POST', body: { code: created.body.connectCode } })
    expect((await head()).seq).toBe(start + 3)
    await h.admin(`/admin/agents/${created.body.id}/rules`, { method: 'PUT', body: { ...rules(), dailyBudgetSats: 9_000 } })
    expect((await head()).seq).toBe(start + 4)
    const last = (await h.admin('/admin/audit?limit=4')).body.entries
    expect(last.map((e: any) => [e.actor, e.type])).toEqual([
      ['admin', 'agent.created'], ['admin', 'agent.connect_code_issued'], [`agent:${created.body.id}`, 'agent.connected'], ['admin', 'agent.rules_changed']
    ])
    expect(last[1].data).toMatchObject({ agentId: created.body.id, oldKeyRevoked: true })
    expect(last[2].data).toEqual({ agentId: created.body.id, keyHint: `${connected.body.apiKey.slice(0, 8)}…` })
    expect(last[3].data).toMatchObject({ before: { dailyBudgetSats: 50_000 }, after: { dailyBudgetSats: 9_000 } })
    expect((await verify()).ok).toBe(true)
  })
})

describe('what a payment leaves in the log', () => {
  it('a payment under the threshold', async () => {
    const agent = await newAgent('logged-bot', 10_000)
    expect((await h.payAndSign(agent, { url: `${merchant}/api/report`, purpose: 'Report' }, REPORT_PRICE_SATS)).status).toBe(200)
    const actor = `agent:${agent.id}`
    expect(await ofAgent(agent.id)).toEqual([
      ['admin', 'agent.created'],
      ['admin', 'agent.connect_code_issued'],
      [actor, 'agent.connected'],
      [actor, 'agent.key_registered'],
      ['company', 'vault.funded'],
      [actor, 'request.created'],
      ['rules', 'request.decided'],
      [actor, 'vault.payment'],
      [actor, 'request.paid']
    ])
    const all = await entries()
    expect(all.find(e => e.type === 'agent.key_registered' && e.data.agentId === agent.id)!.data.fingerprint).toBe(fp(agent))
    const paid = all.find(e => e.type === 'request.paid' && e.data.agentId === agent.id)!
    const payment = all.find(e => e.type === 'vault.payment' && e.data.agentId === agent.id)!
    expect(paid.data).toMatchObject({ priceSats: REPORT_PRICE_SATS, txid: payment.data.txid })
    expect(payment.data).toMatchObject({ from: 'agent_vault', priceSats: REPORT_PRICE_SATS })
  })

  it('a payment above the threshold, approved by funding, then a denial', async () => {
    const agent = await newAgent('approved-logged-bot', 5_000)
    const hotel = { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel' }
    const id = (await h.pay(agent, hotel)).body.requestId
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    const exec = await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })
    expect((await h.sign(agent, exec.body, ROOM_RATES_SATS.standard)).status).toBe(200)
    const denied = (await h.pay(agent, { ...hotel, purpose: 'Second hotel' })).body.requestId
    await h.admin(`/admin/requests/${denied}/deny`, { method: 'POST', body: { reason: 'one is enough' } })

    const actor = `agent:${agent.id}`
    expect((await ofAgent(agent.id)).slice(5)).toEqual([
      [actor, 'request.created'],
      ['company', 'request_vault.funded'],
      ['company', 'request.decided'],
      [actor, 'vault.payment'],
      [actor, 'request.paid'],
      [actor, 'request.created'],
      ['admin', 'request.decided']
    ])
    const decisions = (await entries()).filter(e => e.type === 'request.decided' && e.data.agentId === agent.id).map(e => e.data)
    expect(decisions).toEqual([
      { requestId: id, agentId: agent.id, decision: 'approved', priceSats: ROOM_RATES_SATS.standard },
      { requestId: denied, agentId: agent.id, decision: 'denied', priceSats: ROOM_RATES_SATS.standard, reason: 'one is enough' }
    ])
    expect((await entries()).find(e => e.type === 'vault.payment' && e.data.requestId === id)!.data.from).toBe('request_vault')
  })

  it('a denial by the rules and an expired request', async () => {
    const agent = await newAgent('expiring-bot', 5_000)
    expect((await h.pay(agent, { url: `${merchant.replace('localhost', '127.0.0.1')}/api/report`, purpose: 'Other host' })).status).toBe(403)
    const id = (await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 1 }, purpose: 'Suite' })).body.requestId
    h.clock.offset = 8 * 86_400_000
    try { await h.admin('/admin/requests') } finally { h.clock.offset = 0 }
    const log = (await entries()).filter(e => e.data.agentId === agent.id).slice(5).map(e => [e.actor, e.type, e.data.decision ?? e.data.was ?? ''])
    expect(log).toEqual([
      [`agent:${agent.id}`, 'request.created', ''],
      ['rules', 'request.decided', 'denied'],
      [`agent:${agent.id}`, 'request.created', ''],
      ['rules', 'request.expired', 'pending']
    ])
    expect((await entries()).find(e => e.type === 'request.expired')!.data.requestId).toBe(id)
  })

  it('no entry holds an agent API key, the admin token or a private key', async () => {
    const text = JSON.stringify(await entries())
    expect(text).not.toMatch(/agt_[0-9a-f]{64}/)
    expect(text).not.toContain(ADMIN_TOKEN)
    for (const a of agents) {
      expect(text).not.toContain(a.key)
      expect(text).not.toContain(a.key.slice(4))
      expect(text).not.toContain(a.signer.toHex())
    }
    expect(text).not.toContain(h.policyRootKey.toHex())
  })
})

describe('anchoring on BSV', () => {
  it('the company anchors the head from its wallet; the proxy checks and records it', async () => {
    const before = await head()
    const anchored = await anchorAuditHead(h.company, h.url, ADMIN_TOKEN)
    expect(anchored).toMatchObject({ seq: before.seq, hash: before.hash, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })

    const listed = (await h.admin('/admin/audit')).body
    expect(listed.anchors).toContainEqual(expect.objectContaining({ seq: before.seq, hash: before.hash, txid: anchored.txid, explorerUrl: `https://test.whatsonchain.com/tx/${anchored.txid}` }))
    expect(listed.entries.at(-1)).toMatchObject({ seq: before.seq + 1, actor: 'company', type: 'audit.anchor_recorded', data: { seq: before.seq, txid: anchored.txid } })
    const v = await verify()
    expect(v.ok).toBe(true)
    expect(v.anchors.find((a: any) => a.txid === anchored.txid).matches).toBe(true)
  })

  it('refuses an anchor with the wrong hash, or a transaction without the OP_RETURN', async () => {
    const { seq } = await head()
    const wrong = await postAnchor(anchorLockingScript('ab'.repeat(32), seq).toHex(), 0)
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toMatch(/does not match audit entry/)
    const plain = await postAnchor(new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(), 1_000)
    expect(plain.status).toBe(400)
    expect(plain.body.error).toMatch(/exactly one AgentTresor audit OP_RETURN/)
    const future = await postAnchor(anchorLockingScript('ab'.repeat(32), seq + 100).toHex(), 0)
    expect(future.body.error).toMatch(/no entry/)
  })

  it('parses only its own anchor script', () => {
    const script = anchorLockingScript('cd'.repeat(32), 42)
    expect(parseAnchorScript(script)).toEqual({ seq: 42, hash: 'cd'.repeat(32) })
    expect(parseAnchorScript(script.toHex().replace('6167656e7474726573', '6167656e7474726574'))).toBeUndefined() // other tag
    expect(parseAnchorScript(new P2PKH().lock(PrivateKey.fromRandom().toAddress()))).toBeUndefined()
  })
})

describe('tampering', () => {
  it('editing one row makes verify fail at that seq', async () => {
    const row = await h.db('audit_log').where({ seq: 3 }).first()
    await h.db('audit_log').where({ seq: 3 }).update({ data: row.data.replace('}', ',"edited":true}') })
    try {
      expect(await verify()).toMatchObject({ ok: false, brokenAt: 3 })
    } finally {
      await h.db('audit_log').where({ seq: 3 }).update({ data: row.data })
    }
    expect((await verify()).ok).toBe(true)
  })

  it('a rewritten chain with recomputed hashes still verifies, but the anchor gives it away', async () => {
    const all = await entries()
    const anchor = (await verify()).anchors[0]
    // Rewrite entry 3 and recompute every hash after it: the chain alone looks valid again.
    let prev = all[1].hash
    for (const e of all.slice(2)) {
      const data = e.seq === 3 ? { ...e.data, name: 'someone-else' } : e.data
      const hash = entryHash(prev, { ...e, data })
      await h.db('audit_log').where({ seq: e.seq }).update({ data: JSON.stringify(data), prev_hash: prev, hash })
      prev = hash
    }
    const v = await verify()
    expect(v.ok).toBe(true)
    expect(v.anchors.find((a: any) => a.txid === anchor.txid).matches).toBe(false)
  })

  it('audit:verify reads a database file and reports a break', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agenttresor-audit-'))
    const file = join(dir, 'proxy.sqlite')
    try {
      const db = await openProxyDb(file)
      const log = new AuditLog(db)
      for (let i = 1; i <= 3; i++) await log.append('admin', 'agent.created', { agentId: `A-${i}` })
      await db.destroy()
      expect(await verifyDatabase(file)).toMatchObject({ ok: true, entries: 3, head: { seq: 3 } })

      const db2 = await openProxyDb(file)
      await db2('audit_log').where({ seq: 2 }).update({ actor: 'company' })
      await db2.destroy()
      expect(await verifyDatabase(file)).toMatchObject({ ok: false, brokenAt: 2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
