/**
 * Old vaults are served with a fresh, mined BEEF. The BEEF stored at funding
 * holds the vault transaction as unmined; once the company's wallet knows it
 * as mined, merging both versions fails ("merged Beef failed validation").
 * A mock Arcade (served from the mock chain, offline) stands in for the network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Beef, Utils } from '@bsv/sdk'
import { approveAndFund, reclaimRequestVault, reclaimVault, walletCallError } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { beefFromArcade, type FetchLike } from '../src/shared/arcade'
import { VaultStore } from '../src/vault/store'
import { ADMIN_TOKEN, createProxyHarness, fp, type ProxyHarness } from './helpers/proxy'

let h: ProxyHarness
let merchant: string, merchantHost: string
const arcade = { down: false, calls: [] as string[] }
const logs: string[] = []

/** GET /tx/:txid as Arcade answers it, from the mock chain: raw tx, and the merkle path once mined. */
const mockArcade: FetchLike = async (url) => {
  arcade.calls.push(url)
  if (arcade.down) throw new Error('connect ECONNREFUSED')
  const txid = /\/tx\/([0-9a-f]{64})$/.exec(url)?.[1]
  const known = txid === undefined ? undefined : await (h.chain.services as any).storage.getTransaction(txid)
  if (known == null) return Response.json({}, { status: 404 })
  const { merklePath } = await h.chain.services.getMerklePath(txid!)
  return Response.json({ rawTx: Utils.toHex(Array.from(known.rawTx as number[])), merklePath: merklePath?.toHex() })
}

const rules = { allowedHosts: [] as string[], maxPerPaymentSats: 20_000, dailyBudgetSats: 100_000, approvalThresholdSats: 1_000 }
const minedIn = (hex: string, txid: string): boolean => Beef.fromString(hex, 'hex').findTxid(txid)?.hasProof === true

beforeAll(async () => {
  h = await createProxyHarness({
    app: { beefFromChain: async txid => await beefFromArcade(txid, 'http://arcade.mock', mockArcade), log: msg => { logs.push(msg) } }
  })
  merchant = await h.listen(createMerchantApp(await h.chain.makeWallet()))
  merchantHost = new URL(merchant).host
  rules.allowedHosts = [merchantHost]
})
afterAll(async () => { await h?.close() })
beforeEach(() => { arcade.down = false; arcade.calls = [] })

describe('agent vault reclaim', () => {
  it('Arcade down: the stored BEEF is served, without an error', async () => {
    const agent = await h.createAgent('arcade-down-bot', rules, 10_000)
    const stored = (await new VaultStore(h.db).getVault(agent.id))!
    arcade.down = true
    const res = await h.admin(`/admin/vaults/${agent.id}/utxo`)
    expect(res.status).toBe(200)
    expect(res.body.beef).toBe(stored.beefHex)
    expect(arcade.calls.length).toBeGreaterThan(0)
    expect(logs.some(l => l.includes('ECONNREFUSED') && l.includes('serving the stored BEEF'))).toBe(true)
  })

  it('not mined yet: the stored BEEF is served and kept', async () => {
    const agent = await h.createAgent('unmined-bot', rules, 10_000)
    const stored = (await new VaultStore(h.db).getVault(agent.id))!
    expect(minedIn(stored.beefHex!, stored.txid!)).toBe(false)
    const res = await h.admin(`/admin/vaults/${agent.id}/utxo`)
    expect(res.body.beef).toBe(stored.beefHex)
    expect((await new VaultStore(h.db).getVault(agent.id))!.beefHex).toBe(stored.beefHex)
  })

  it('mined: utxo serves the mined BEEF, saves it, then needs no Arcade call; the company reclaims with it', async () => {
    const agent = await h.createAgent('mined-bot', rules, 10_000)
    const store = new VaultStore(h.db)
    const stored = (await store.getVault(agent.id))!
    await h.chain.mineBlock()

    const res = await h.admin(`/admin/vaults/${agent.id}/utxo`)
    expect(res.status).toBe(200)
    expect(res.body.beef).not.toBe(stored.beefHex)
    expect(minedIn(res.body.beef, stored.txid!)).toBe(true)
    expect((await store.getVault(agent.id))!.beefHex).toBe(res.body.beef)
    expect(arcade.calls).toEqual([`http://arcade.mock/tx/${stored.txid!}`])

    // Already mined in the store: no lookup at all.
    arcade.calls = []
    expect((await h.admin(`/admin/vaults/${agent.id}/utxo`)).body.beef).toBe(res.body.beef)
    expect(arcade.calls).toEqual([])

    const reclaimed = await reclaimVault(h.company, h.url, ADMIN_TOKEN, agent.id)
    expect(reclaimed.satoshis).toBe(10_000)
    expect((await store.getVault(agent.id))!.status).toBe('closed')
  })
})

describe('payments and request vaults', () => {
  it('a payment from an old (mined) vault spends it with the fresh BEEF', async () => {
    const agent = await h.createAgent('old-vault-payer', rules, 10_000)
    const store = new VaultStore(h.db)
    const fundingTxid = (await store.getVault(agent.id))!.txid!
    await h.chain.mineBlock()
    const paid = await h.payAndSign(agent, { url: `${merchant}/api/report`, purpose: 'Report' }, REPORT_PRICE_SATS)
    expect(paid.status).toBe(200)
    // The vault moved to the change output; its BEEF has the funding tx with its proof.
    const after = (await store.getVault(agent.id))!
    expect(after.txid).not.toBe(fundingTxid)
    expect(minedIn(after.beefHex!, fundingTxid)).toBe(true)
  })

  it('a mined request vault is served with a fresh BEEF and saved', async () => {
    const agent = await h.createAgent('old-request-bot', rules, 10_000)
    const res = await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    await approveAndFund(h.company, h.url, ADMIN_TOKEN, id, fp(agent))
    await h.chain.mineBlock()

    const store = new VaultStore(h.db)
    const rv = (await store.getRequestVault(id))!
    const utxo = await h.admin(`/admin/request-vaults/${id}/utxo`)
    expect(utxo.status).toBe(200)
    expect(minedIn(utxo.body.beef, rv.txid)).toBe(true)
    expect((await store.getRequestVault(id))!.beefHex).toBe(utxo.body.beef)

    const reclaimed = await reclaimRequestVault(h.company, h.url, ADMIN_TOKEN, id)
    expect(reclaimed.satoshis).toBe(rv.satoshis)
    expect(ROOM_RATES_SATS.standard).toBeLessThan(rv.satoshis)
  })
})

describe('wallet errors', () => {
  it('an HTTP-status-only failure says so and points to the response body', () => {
    const err = walletCallError('signAction', new Error('HTTPWalletJSON signAction failed with HTTP status 400'))
    expect(err.message).toBe('the wallet refused signAction (HTTP 400) without saying why')
    expect(err.hint).toBe('open DevTools > Network > signAction > Response for details')
  })

  it('keeps the wallet\'s own reason and code', () => {
    const werr = Object.assign(new Error('Storage method processAction failed: merged Beef failed validation'), { code: 'WERR_INTERNAL' })
    const err = walletCallError('signAction', werr)
    expect(err.message).toMatch(/^the wallet refused signAction: Storage method processAction failed: merged Beef failed validation \(WERR_INTERNAL\)/)
    expect(err.message).toMatch(/reload the page/)
    expect(err.hint).toMatch(/DevTools/)
  })
})
