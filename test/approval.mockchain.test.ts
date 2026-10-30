/**
 * On-chain human approval, end to end on the mock chain. A payment above the
 * approval threshold is impossible until the company funds a request vault for
 * exactly that payment from its own wallet; the agent then pays from it with
 * the usual two signatures, and the agent's own vault is not touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import { P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { signVaultPayment, type VaultSignAnswer } from '../src/agent/vault-signer'
import { approveAndFund, confirmedFingerprint, getApproval, reclaimRequestVault } from '../src/company/vault-client'
import { createMerchantApp, ROOM_RATES_SATS } from '../src/merchant/app'
import { createPaymentMiddleware } from '../src/shared/brc121'
import { vaultLockingScript } from '../src/vault/script'
import { fingerprint } from '../src/shared/fingerprint'
import { ADMIN_TOKEN, createProxyHarness, fp, spendableSats, type ProxyHarness, type TestAgent } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet, shopWallet: Wallet
let merchant: string, shop: string
const shopState = { price: 3_000 }

/** A merchant whose price the test changes. */
function createShop (wallet: Wallet): Express {
  const app = express()
  app.get('/item', createPaymentMiddleware({ wallet, calculatePrice: () => shopState.price }), (_req, res) => { res.json({ item: 'widget' }) })
  return app
}

const rules = (extra: object = {}): object => ({
  allowedHosts: [new URL(merchant).host, new URL(shop).host], maxPerPaymentSats: 10_000, dailyBudgetSats: 50_000, approvalThresholdSats: 1_000, ...extra
})
const hotel = (nights = 1): object => ({ url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights }, purpose: `Hotel, ${nights} night(s)` })
const requestOf = async (a: TestAgent, id: string): Promise<any> => (await h.call(`/v1/requests/${id}`, a.key)).body
const requestVault = async (id: string): Promise<any> => (await h.admin('/admin/request-vaults')).body.requestVaults.find((v: any) => v.requestId === id)
const execute = async (a: TestAgent, id: string): Promise<{ status: number, body: any }> => await h.call(`/v1/requests/${id}/execute`, a.key, { method: 'POST' })

/** Funds a request vault by hand, to send the proxy something other than what approveAndFund would. */
async function fundByHand (requestId: string, opts: { extraSats?: number, companyPub?: string } = {}): Promise<{ status: number, body: any }> {
  const a = await getApproval(h.url, ADMIN_TOKEN, requestId)
  const { publicKey: companyPub } = await h.company.getPublicKey({ protocolID: a.protocolID, keyID: a.keyID, counterparty: 'self' })
  const lockingScript = vaultLockingScript({ agentPub: a.agentPub, policyPub: a.policyPub, companyPub: opts.companyPub ?? companyPub }).toHex()
  const created = await h.company.createAction({
    description: 'Approve by hand',
    outputs: [{ lockingScript, satoshis: a.totalSats + (opts.extraSats ?? 0), outputDescription: 'request vault' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const vout = Transaction.fromAtomicBEEF(created.tx!).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  return await h.admin(`/admin/requests/${requestId}/approve`, { method: 'POST', body: { beef: Utils.toHex(created.tx!), vout, companyPub } })
}

beforeAll(async () => {
  h = await createProxyHarness()
  ;[merchantWallet, shopWallet] = await Promise.all([h.chain.makeWallet(), h.chain.makeWallet()])
  merchant = await h.listen(createMerchantApp(merchantWallet))
  shop = await h.listen(createShop(shopWallet))
})
afterAll(async () => { await h?.close() })

describe('approval = funding', () => {
  it('pending → plain approve refused → company funds → agent pays from the request vault; its own vault is untouched', async () => {
    const agent = await h.createAgent('approved-bot', rules(), 20_000)
    const res = await h.pay(agent, hotel())
    expect(res.status).toBe(202)
    const id = res.body.requestId

    // Without funding nothing is approved.
    const plain = await h.admin(`/admin/requests/${id}/approve`, { method: 'POST' })
    expect(plain.status).toBe(400)
    expect(plain.body.error).toMatch(/takes funding it/)
    expect((await requestOf(agent, id)).status).toBe('pending')
    expect((await execute(agent, id)).status).toBe(409)

    const approval = await getApproval(h.url, ADMIN_TOKEN, id)
    expect(approval).toMatchObject({ requestId: id, agentName: 'approved-bot', purpose: 'Hotel, 1 night(s)', priceSats: ROOM_RATES_SATS.standard, protocolID: [1, 'agenttresor vault'] })
    expect(approval.feeSats).toBeGreaterThan(0)
    expect(approval.totalSats).toBe(approval.priceSats + approval.feeSats)

    // Approve-and-fund also needs the confirmed fingerprint.
    await expect(approveAndFund(h.company, h.url, ADMIN_TOKEN, id, confirmedFingerprint(fp(agent), false))).rejects.toThrow(/confirm it before funding/)
    await expect(approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fingerprint(PrivateKey.fromRandom().toPublicKey().toString()))).rejects.toThrow(/agent key changed/)
    expect((await requestOf(agent, id)).status).toBe('pending')

    const funded = await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    expect(funded.satoshis).toBe(approval.totalSats)
    expect(await requestOf(agent, id)).toMatchObject({ status: 'approved', decidedBy: 'company' })
    expect(await requestVault(id)).toMatchObject({ status: 'open', requestStatus: 'approved', reclaimable: false, satoshis: approval.totalSats })

    const [agentVaultBefore, merchantBefore] = [(await h.call('/v1/budget', agent.key)).body.vault, await spendableSats(merchantWallet)]
    const exec = await execute(agent, id)
    expect(exec.status).toBe(200)
    const answer = exec.body as VaultSignAnswer
    const tx = Transaction.fromHex(answer.unsignedTx)
    expect(tx.outputs).toHaveLength(1)
    expect(`${tx.inputs[0].sourceTXID!}.${tx.inputs[0].sourceOutputIndex}`).toBe(`${funded.txid}.${funded.vout}`)
    expect(answer).toMatchObject({ sourceSatoshis: approval.totalSats, feeSats: approval.feeSats, merchantOutput: { satoshis: ROOM_RATES_SATS.standard } })

    const paid = await h.sign(agent, answer, ROOM_RATES_SATS.standard)
    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'paid', satoshis: ROOM_RATES_SATS.standard })
    expect(paid.body.response.body.order).toMatchObject({ roomType: 'standard', nights: 1 })
    expect(await spendableSats(merchantWallet)).toBe(merchantBefore + ROOM_RATES_SATS.standard)
    expect(await requestVault(id)).toMatchObject({ status: 'spent', reclaimable: false })
    expect((await h.call('/v1/budget', agent.key)).body.vault).toEqual(agentVaultBefore)
    expect((await h.call('/v1/budget', agent.key)).body.spentTodaySats).toBe(ROOM_RATES_SATS.standard)
  })

  it('refuses a funding with the wrong amount or the wrong script', async () => {
    const agent = await h.createAgent('wrong-funding-bot', rules(), 5_000)
    const id = (await h.pay(agent, hotel())).body.requestId

    const tooMuch = await fundByHand(id, { extraSats: 1 })
    expect(tooMuch.status).toBe(400)
    expect(tooMuch.body.error).toMatch(/takes exactly/)
    const wrongScript = await fundByHand(id, { companyPub: PrivateKey.fromRandom().toPublicKey().toString() })
    expect(wrongScript.status).toBe(400)
    expect(wrongScript.body.error).toMatch(/not this agent's vault script/)
    expect((await requestOf(agent, id)).status).toBe('pending')
    expect(await requestVault(id)).toBeUndefined()

    expect((await fundByHand(id)).status).toBe(200) // the exact funding is accepted
    await expect(fundByHand(id)).rejects.toThrow(/approved, not pending/) // and only once: nothing more is funded
  })

  it('a denied request gets no vault', async () => {
    const agent = await h.createAgent('denied-bot', rules(), 5_000)
    const id = (await h.pay(agent, hotel())).body.requestId
    expect((await h.admin(`/admin/requests/${id}/deny`, { method: 'POST', body: { reason: 'not this week' } })).status).toBe(200)
    expect((await h.admin(`/admin/requests/${id}/approval`)).status).toBe(409)
    await expect(fundByHand(id)).rejects.toThrow(/denied, not pending/)
    expect(await requestVault(id)).toBeUndefined()
    expect((await execute(agent, id)).status).toBe(409)
  })
})

describe('when an approved payment cannot happen, the company reclaims', () => {
  it('price changed (even down): the request fails, nothing is paid, the company takes the funds back', async () => {
    const agent = await h.createAgent('price-bot', rules(), 5_000)
    shopState.price = 3_000
    const id = (await h.pay(agent, { url: `${shop}/item`, purpose: 'Widget' })).body.requestId
    const funded = await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))

    shopState.price = 2_900 // cheaper, but not what the company approved
    const shopBefore = await spendableSats(shopWallet)
    const exec = await execute(agent, id)
    shopState.price = 3_000
    expect(exec.status).toBe(409)
    expect(exec.body).toMatchObject({ status: 'failed', reason: expect.stringMatching(/price changed from 3000 to 2900/) })
    expect(await spendableSats(shopWallet)).toBe(shopBefore)
    expect(await requestVault(id)).toMatchObject({ status: 'open', requestStatus: 'failed', reclaimable: true })

    const companyBefore = await spendableSats(h.company)
    const reclaimed = await reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, id)
    expect(reclaimed.satoshis).toBe(funded.satoshis)
    expect(await spendableSats(h.company)).toBeGreaterThan(companyBefore + funded.satoshis - 100)
    expect(await requestVault(id)).toMatchObject({ status: 'reclaimed', reclaimable: false })
    await expect(reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, id)).rejects.toThrow(/no open request vault/)
  })

  it('the daily budget still applies at execute time', async () => {
    const agent = await h.createAgent('budget-bot', rules({ dailyBudgetSats: 2_400 }), 5_000)
    const id = (await h.pay(agent, hotel())).body.requestId // 2000, fits the budget now
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    expect((await h.payAndSign(agent, { url: `${merchant}/api/report`, purpose: 'Report' }, 500)).status).toBe(200) // 500 spent meanwhile

    const exec = await execute(agent, id)
    expect(exec.status).toBe(403)
    expect(exec.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/daily budget/) })
    expect(await requestVault(id)).toMatchObject({ status: 'open', reclaimable: true })
  })

  it('an approval not executed in time expires and becomes reclaimable', async () => {
    const agent = await h.createAgent('slow-bot', rules(), 5_000)
    const id = (await h.pay(agent, hotel())).body.requestId
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    h.clock.offset = 25 * 3600_000
    try {
      expect(await requestVault(id)).toMatchObject({ status: 'open', requestStatus: 'expired', reclaimable: true })
    } finally {
      h.clock.offset = 0
    }
    expect((await execute(agent, id)).status).toBe(409)
    expect((await reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, id)).satoshis).toBeGreaterThan(ROOM_RATES_SATS.standard)
  })

  it('reclaiming a still-approved request withdraws the approval', async () => {
    const agent = await h.createAgent('withdrawn-bot', rules(), 5_000)
    const id = (await h.pay(agent, hotel())).body.requestId
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    await reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, id)
    expect(await requestOf(agent, id)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/reclaimed/) })
    expect((await execute(agent, id)).status).toBe(409)
  })
})

describe('vault signer, 1-output form (request vault)', () => {
  const agentKey = PrivateKey.fromRandom()
  const lockingScript = vaultLockingScript({
    agentPub: agentKey.toPublicKey().toString(),
    policyPub: PrivateKey.fromRandom().toPublicKey().toString(),
    companyPub: PrivateKey.fromRandom().toPublicKey().toString()
  }).toHex()
  const merchantScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()

  /** A 'sign' answer spending a request vault of `vaultSats` with one output of `pays`. */
  function answer (vaultSats: number, pays: number, announced: Partial<VaultSignAnswer> = {}): VaultSignAnswer {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: pays, lockingScript: new P2PKH().lock(Utils.toArray(merchantScript.slice(6, 46), 'hex')) })
    return {
      status: 'sign',
      requestId: 'R-0000000000',
      unsignedTx: tx.toHex(),
      sourceSatoshis: vaultSats,
      sourceLockingScript: lockingScript,
      merchantOutput: { satoshis: pays, lockingScript: merchantScript },
      feeSats: vaultSats - pays,
      ...announced
    }
  }

  it('signs when output 0 pays exactly the price and the fee is small', () => {
    expect(signVaultPayment(answer(2_030, 2_000), agentKey, 2_000)).toMatch(/^30[0-9a-f]+$/)
  })

  it('refuses a wrong price', () => {
    expect(() => signVaultPayment(answer(2_030, 2_010), agentKey, 2_000)).toThrow(/output 0 pays 2010 sats, expected 2000/)
  })

  it('refuses too high a fee: the rest of the vault would go to the miners', () => {
    expect(() => signVaultPayment(answer(7_000, 2_000), agentKey, 2_000)).toThrow(/fee 5000 sats is above the limit of 1000/)
    expect(() => signVaultPayment(answer(2_300, 2_000), agentKey, 2_000, { maxFeeSats: 100 })).toThrow(/above the limit of 100/)
  })

  it('refuses a fee that differs from the announced one', () => {
    expect(() => signVaultPayment(answer(2_030, 2_000, { feeSats: 10 }), agentKey, 2_000)).toThrow(/fee is 30 sats, announced 10/)
  })
})
