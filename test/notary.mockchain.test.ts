/**
 * Anchoring without the company clicking anything: vault payments carry an
 * anchor of the audit log head (option A), and the operator's notary wallet
 * anchors the head once the log has been idle (option B). Covers top-ups and
 * the low-balance alert. Mock chain; the notary's scheduler is driven by
 * calling tick() with the proxy clock moved forward.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { P2PKH, PublicKey, Random, Transaction, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { parseAnchorScript } from '../src/audit/anchor-script'
import { DEFAULT_NOTARY_CONFIG, type NotaryAlert } from '../src/audit/notary'
import { anchorAuditHead } from '../src/company/audit-client'
import { topUpNotary } from '../src/company/notary-client'
import { createMerchantApp, REPORT_PRICE_SATS } from '../src/merchant/app'
import { DashboardNotifier, type Notifier } from '../src/proxy/notifier'
import { ADMIN_TOKEN, createProxyHarness, type ProxyHarness } from './helpers/proxy'

const IDLE_MS = 10_000 // shorter than the 20 s signing window, so a payment can be "in flight" while the log is idle

/** Records low-balance alerts; everything else as on the dashboard. */
class AlertSpy implements Notifier {
  alerts: NotaryAlert[] = []
  async approvalNeeded (): Promise<void> {}
  async decided (): Promise<void> {}
  async lowNotaryBalance (alert: NotaryAlert): Promise<void> { this.alerts.push(alert) }
}

const makeNotaryWallet = (holder: { wallet?: Wallet }) => async (chain: { makeWallet: () => Promise<Wallet> }): Promise<Wallet> => {
  holder.wallet = await chain.makeWallet()
  return holder.wallet
}
const notaryOf = (h: ProxyHarness) => h.notary!
const status = async (h: ProxyHarness): Promise<any> => (await h.admin('/admin/notary')).body
const anchors = async (h: ProxyHarness): Promise<any[]> => (await h.admin('/admin/audit?limit=1')).body.anchors
const entriesOfType = async (h: ProxyHarness, type: string): Promise<any[]> =>
  (await h.admin('/admin/audit?limit=1000')).body.entries.filter((e: any) => e.type === type)
/** Moves the proxy clock past the idle time. */
const idle = (h: ProxyHarness): void => { h.clock.offset += IDLE_MS + 1_000 }
const onChain = async (h: ProxyHarness, txid: string): Promise<boolean> => (await (h.chain.services as any).storage.getTransaction(txid)) != null

/** An anchor fee measured in the first suite, so the low-balance suite can put the balance right at the threshold. */
let measuredFee = 0

describe('notary: out of funds, top-up, idle anchoring', () => {
  let h: ProxyHarness
  const spy = new AlertSpy()
  const logs: string[] = []
  const holder: { wallet?: Wallet } = {}

  beforeAll(async () => {
    h = await createProxyHarness({ notifier: spy, notary: { wallet: makeNotaryWallet(holder), config: { idleMs: IDLE_MS, maxSats: 20_000 }, log: m => logs.push(m) } })
  })
  afterAll(async () => { await h?.close() })

  it('out of funds: no crash, logged once, status and red banner reported; manual anchors still work', async () => {
    await h.admin('/admin/agents', { method: 'POST', body: { name: 'notary-bot' } })
    idle(h)
    expect(await notaryOf(h).tick()).toEqual({ skipped: 'out of funds' })
    // Its own "notary.low_balance" entry made the log fresh again.
    idle(h)
    expect(await notaryOf(h).tick()).toEqual({ skipped: 'out of funds' })
    expect(logs.filter(l => /out of funds/.test(l) && /paused/.test(l))).toHaveLength(1)

    const s = await status(h)
    expect(s).toMatchObject({ enabled: true, balanceSats: 0, anchorsLeft: 0, outOfFunds: true, level: 'empty', identityKey: holder.wallet!.identityKey })
    expect(s.banner).toMatch(/Notary out of funds/)
    // Crossing into 'empty' alerts once, however often it is checked.
    await status(h)
    expect(spy.alerts).toEqual([expect.objectContaining({ level: 'empty', balanceSats: 0, anchorsLeft: 0 })])
    expect(await entriesOfType(h, 'notary.low_balance')).toHaveLength(1)

    // The company can still anchor from its own wallet.
    const manual = await anchorAuditHead(h.company, h.url, ADMIN_TOKEN)
    expect((await anchors(h)).at(-1)).toMatchObject({ txid: manual.txid, source: 'company' })
  })

  it('top-up: a BRC-29 payment the notary internalizes; the balance shows and the banner clears', async () => {
    const r = await topUpNotary(h.company, h.url, ADMIN_TOKEN, 5_000)
    expect(r).toMatchObject({ satoshis: 5_000, balanceSats: 5_000 })
    const s = await status(h)
    expect(s).toMatchObject({ balanceSats: 5_000, outOfFunds: false, level: 'ok', banner: null, anchorsLeft: Math.floor(5_000 / 30), topUpRoomSats: 15_000 })
    expect((await entriesOfType(h, 'notary.topped_up')).at(-1)).toMatchObject({ actor: 'company', data: { txid: r.txid, satoshis: 5_000, balanceSats: 5_000 } })
    expect(spy.alerts).toHaveLength(1) // getting better does not alert
  })

  it('refuses a top-up over NOTARY_MAX_SATS, or one not paid to the notary', async () => {
    await expect(topUpNotary(h.company, h.url, ADMIN_TOKEN, 15_001)).rejects.toThrow(/at most 20000 sats/)

    // Hand-made payments, past the client's own check.
    const pay = async (sats: number, counterparty: string): Promise<{ status: number, body: any }> => {
      const prefix = Utils.toBase64(Random(8))
      const suffix = Utils.toBase64(Random(8))
      const { publicKey } = await h.company.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${prefix} ${suffix}`, counterparty, forSelf: false })
      const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()
      const created = await h.company.createAction({ description: 'Notary top-up test', outputs: [{ lockingScript, satoshis: sats, outputDescription: 'top-up test' }], options: { randomizeOutputs: false, acceptDelayedBroadcast: false } })
      const outputIndex = Transaction.fromAtomicBEEF(created.tx!).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
      return await h.admin('/admin/notary/topup', { method: 'POST', body: { beef: Utils.toHex(created.tx!), outputIndex, derivationPrefix: prefix, derivationSuffix: suffix, senderIdentityKey: h.company.identityKey } })
    }
    const over = await pay(15_001, holder.wallet!.identityKey)
    expect(over.status).toBe(400)
    expect(over.body).toMatchObject({ code: 'NOTARY_CAP' })
    const elsewhere = await pay(1_000, h.company.identityKey)
    expect(elsewhere.status).toBe(400)
    expect(elsewhere.body.error).toMatch(/not a BRC-29 payment to the notary/)
    expect((await status(h)).balanceSats).toBe(5_000)
  })

  it('anchors the head once the newest entry is older than ANCHOR_IDLE_MS; recorded and verified', async () => {
    await h.admin('/admin/agents', { method: 'POST', body: { name: 'fresh-bot' } })
    expect(await notaryOf(h).tick()).toEqual({ skipped: 'entries are still fresh' })

    idle(h)
    const head = await h.admin('/admin/audit/head')
    expect(head.body.unanchoredEntries).toBeGreaterThan(0)
    const t = await notaryOf(h).tick()
    expect(t).toMatchObject({ anchored: { seq: head.body.seq, hash: head.body.hash, source: 'notary' } })
    const anchor = (t as any).anchored
    expect(anchor.feeSats).toBeGreaterThan(0)
    measuredFee = anchor.feeSats
    expect(await onChain(h, anchor.txid)).toBe(true)

    expect((await anchors(h)).at(-1)).toMatchObject({ seq: head.body.seq, txid: anchor.txid, source: 'notary', feeSats: anchor.feeSats })
    expect((await entriesOfType(h, 'audit.anchor_recorded')).at(-1)).toMatchObject({ actor: 'notary', data: { seq: head.body.seq, txid: anchor.txid, source: 'notary' } })
    const verify = (await h.admin('/admin/audit/verify?full=1')).body
    expect(verify.ok).toBe(true)
    expect(verify.anchors.every((a: any) => a.matches)).toBe(true)
    expect((await h.admin('/admin/audit/head')).body.unanchoredEntries).toBe(0)
    expect(await notaryOf(h).tick()).toEqual({ skipped: 'nothing to anchor' })

    const s = await status(h)
    expect(s).toMatchObject({ balanceSats: 5_000 - anchor.feeSats, avgAnchorCostSats: anchor.feeSats, level: 'ok' })
    expect(logs.some(l => l.includes(`anchored audit log #${head.body.seq}`))).toBe(true)
  })

  it('runs one anchor at a time', async () => {
    await h.admin('/admin/agents', { method: 'POST', body: { name: 'race-bot' } })
    idle(h)
    const [a, b] = await Promise.all([notaryOf(h).tick(), notaryOf(h).tick()])
    expect([a, b].filter(t => 'anchored' in t)).toHaveLength(1)
    expect([a, b]).toContainEqual({ skipped: 'an anchor is already in flight' })
  })
})

describe('payments anchor the log; the notary waits for them', () => {
  let h: ProxyHarness
  let merchant: string
  const holder: { wallet?: Wallet } = {}

  beforeAll(async () => {
    h = await createProxyHarness({ notary: { wallet: makeNotaryWallet(holder), config: { idleMs: IDLE_MS } } })
    await h.chain.fund(holder.wallet!, 10_000)
    merchant = await h.listen(createMerchantApp(await h.chain.makeWallet()))
  })
  afterAll(async () => { await h?.close() })

  it('no anchor while a payment is being built; the payment carries one, and the notary skips', async () => {
    const rules = { allowedHosts: [new URL(merchant).host], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000 }
    const agent = await h.createAgent('paying-bot', rules, 10_000)
    idle(h)

    // The payment is built: the log head goes into it, and the notary must not race it.
    const built = await h.pay(agent, { url: `${merchant}/api/report`, purpose: 'Market report' })
    expect(built.body.status).toBe('sign')
    const tx = Transaction.fromHex(built.body.unsignedTx)
    const carried = parseAnchorScript(tx.outputs.at(-1)!.lockingScript)
    expect(carried).toBeDefined()
    expect(tx.outputs.at(-1)!.satoshis).toBe(0)
    h.clock.offset += IDLE_MS + 1_000 // the log is idle again, but the payment still waits for its signature
    expect(await h.notary!.tick()).toEqual({ skipped: 'a vault payment is being built' })

    const paid = await h.sign(agent, built.body, REPORT_PRICE_SATS)
    expect(paid.body.status).toBe('paid')
    const latest = (await anchors(h)).at(-1)
    expect(latest).toMatchObject({ seq: carried!.seq, hash: carried!.hash, txid: paid.body.txid, source: 'payment' })
    expect((await entriesOfType(h, 'audit.anchor_recorded')).at(-1)).toMatchObject({ actor: 'proxy', data: { txid: paid.body.txid, source: 'payment' } })

    // Right after the payment the log is fresh: the notary has nothing to do yet.
    expect(await h.notary!.tick()).toEqual({ skipped: 'entries are still fresh' })
    expect((await anchors(h)).filter(a => a.source === 'notary')).toHaveLength(0)
    expect((await h.admin('/admin/audit/verify?full=1')).body).toMatchObject({ ok: true })
    expect((await h.admin('/admin/audit/verify?full=1')).body.anchors.every((a: any) => a.matches)).toBe(true)

    // Later, once idle, it anchors what came after the payment's own anchor.
    idle(h)
    const t = await h.notary!.tick()
    expect(t).toMatchObject({ anchored: { source: 'notary' } })
    expect((t as any).anchored.seq).toBeGreaterThan(carried!.seq)
  })

  it('AUTO_ANCHOR_PAYMENTS off: payments carry no anchor', async () => {
    const plain = await createProxyHarness()
    try {
      const { createProxyApp } = await import('../src/proxy/app')
      const url = await plain.listen(createProxyApp({
        db: plain.db, policyRootKey: plain.policyRootKey, chainTracker: plain.chain.chainTracker, broadcaster: plain.chain.broadcaster,
        notifier: new DashboardNotifier(), adminToken: ADMIN_TOKEN, network: 'test', anchorPayments: false
      }))
      expect((await fetch(`${url}/admin/notary`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }).then(async r => await r.json()))).toMatchObject({ enabled: false })
      // Same database, so an agent made through the harness proxy pays through this one.
      const rules = { allowedHosts: [new URL(merchant).host], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000 }
      const agent = await plain.createAgent('plain-bot', rules, 10_000)
      const res = await fetch(`${url}/v1/pay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.key}` }, body: JSON.stringify({ url: `${merchant}/api/report`, purpose: 'Report' }) })
      const body = await res.json() as any
      expect(body.status).toBe('sign')
      expect(Transaction.fromHex(body.unsignedTx).outputs.every(o => parseAnchorScript(o.lockingScript) === undefined)).toBe(true)
    } finally {
      await plain.close()
    }
  })
})

describe('low-balance alert', () => {
  let h: ProxyHarness
  const spy = new AlertSpy()
  const holder: { wallet?: Wallet } = {}

  beforeAll(async () => {
    expect(measuredFee).toBeGreaterThan(0)
    // Until the notary has anchored, it assumes the fee measured above, so the threshold sits where the test puts it.
    h = await createProxyHarness({ notifier: spy, notary: { wallet: makeNotaryWallet(holder), config: { idleMs: IDLE_MS, lowAnchors: 20, defaultAnchorCostSats: measuredFee } } })
  })
  afterAll(async () => { await h?.close() })

  it('crossing below NOTARY_LOW_ANCHORS notifies once; topping up clears the banner', async () => {
    // A new notary holds nothing: that is the red level, alerted on the first check. Default cap: 1,000,000 sats.
    expect(DEFAULT_NOTARY_CONFIG.maxSats).toBe(1_000_000)
    expect(await status(h)).toMatchObject({ level: 'empty', balanceSats: 0, maxSats: 1_000_000, topUpRoomSats: 1_000_000 })
    expect(spy.alerts.map(a => a.level)).toEqual(['empty'])

    // 20½ anchors' worth: ok again, no new alert.
    await topUpNotary(h.company, h.url, ADMIN_TOKEN, 20 * measuredFee + Math.ceil(measuredFee / 2))
    expect(await status(h)).toMatchObject({ level: 'ok', anchorsLeft: 20, banner: null })
    spy.alerts.length = 0

    // One anchor later fewer than 20 are left: orange banner, one notification, one audit entry.
    await h.admin('/admin/agents', { method: 'POST', body: { name: 'low-bot' } })
    idle(h)
    expect(await h.notary!.tick()).toMatchObject({ anchored: { source: 'notary' } })
    const low = await status(h)
    expect(low).toMatchObject({ level: 'low', anchorsLeft: 19 })
    expect(low.banner).toBe('Notary: about 19 anchors left — top up from BSV Desktop')
    expect(spy.alerts).toEqual([expect.objectContaining({ level: 'low', anchorsLeft: 19, message: low.banner })])

    // Checking again, and anchoring again at the same level, does not repeat it.
    await status(h)
    idle(h)
    expect(await h.notary!.tick()).toMatchObject({ anchored: { source: 'notary' } })
    expect((await status(h)).level).toBe('low')
    expect(spy.alerts).toHaveLength(1)
    const audited = (await entriesOfType(h, 'notary.low_balance')).filter(e => e.data.level === 'low')
    expect(audited).toHaveLength(1)
    expect(audited[0]).toMatchObject({ actor: 'notary', data: { level: 'low', anchorsLeft: 19, lowAnchors: 20 } })

    // A top-up clears the banner.
    await topUpNotary(h.company, h.url, ADMIN_TOKEN, 2_000)
    expect(await status(h)).toMatchObject({ level: 'ok', banner: null })
    expect(spy.alerts).toHaveLength(1)
  })
})
