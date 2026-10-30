/**
 * Demo merchant (BRC-121), end to end on the mock chain: an agent's wallet pays
 * automatically with create402Fetch, the merchant is credited at once, replays
 * are refused, and the hotel price follows the request body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Wallet } from '@bsv/wallet-toolbox'
import { constructPaymentHeaders, create402Fetch, withHostOriginator } from '../src/shared/brc121'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
let merchant: Wallet, buyer: Wallet
let server: Server
let url: string

const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const withHeaders = (init: RequestInit, headers: object): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), ...(headers as Record<string, string>) } })

beforeAll(async () => {
  chain = await createMockChain()
  ;[merchant, buyer] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
  await chain.fund(buyer)
  server = await new Promise(resolve => { const s = createMerchantApp(merchant).listen(0, () => resolve(s)) })
  url = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise(resolve => server?.close(resolve))
  await chain?.close()
})

describe('catalog', () => {
  it('is free and lists each paid route with its price', async () => {
    const res = await fetch(`${url}/api/catalog`)
    expect(res.status).toBe(200)
    const { items } = await res.json()
    expect(items).toContainEqual(expect.objectContaining({ path: '/api/report', category: 'data', priceSats: REPORT_PRICE_SATS }))
    expect(items).toContainEqual(expect.objectContaining({ path: '/api/hotel/book', category: 'travel', priceSatsPerNight: ROOM_RATES_SATS }))
  })
})

describe('report (fixed price)', () => {
  it('challenges an unpaid request with 402, the price and the merchant key', async () => {
    const res = await fetch(`${url}/api/report`)
    expect(res.status).toBe(402)
    expect(res.headers.get('x-bsv-sats')).toBe(String(REPORT_PRICE_SATS))
    expect(res.headers.get('x-bsv-server')).toBe(merchant.identityKey)
  })

  it('create402Fetch pays; the answer has a receipt and the order; the merchant is credited', async () => {
    const before = await spendableSats(merchant)
    const res = await create402Fetch({ wallet: withHostOriginator(buyer) })(`${url}/api/report`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.receipt).toMatchObject({ satoshisPaid: REPORT_PRICE_SATS, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(body.order.reportId).toEqual(expect.any(String))
    expect(await spendableSats(merchant)).toBe(before + REPORT_PRICE_SATS)
  })

  it('refuses the same payment headers twice (fresh 402)', async () => {
    const headers = await constructPaymentHeaders(withHostOriginator(buyer), `${url}/api/report`, REPORT_PRICE_SATS, merchant.identityKey)
    const first = await fetch(`${url}/api/report`, { headers: headers as unknown as Record<string, string> })
    expect(first.status).toBe(200)
    const replay = await fetch(`${url}/api/report`, { headers: headers as unknown as Record<string, string> })
    expect(replay.status).toBe(402)
  })
})

describe('hotel booking (price from the body)', () => {
  it('prices nights x room rate on the server', async () => {
    const suite3 = await fetch(`${url}/api/hotel/book`, json({ roomType: 'suite', nights: 3 }))
    expect(suite3.status).toBe(402)
    expect(suite3.headers.get('x-bsv-sats')).toBe(String(3 * ROOM_RATES_SATS.suite))
    const standard1 = await fetch(`${url}/api/hotel/book`, json({ roomType: 'standard', nights: 1 }))
    expect(standard1.headers.get('x-bsv-sats')).toBe(String(ROOM_RATES_SATS.standard))
  })

  it('refuses an invalid body before asking for payment', async () => {
    const res = await fetch(`${url}/api/hotel/book`, json({ roomType: 'penthouse', nights: 2 }))
    expect(res.status).toBe(400)
    expect((await fetch(`${url}/api/hotel/book`, json({ roomType: 'suite', nights: 0 }))).status).toBe(400)
  })

  it('create402Fetch pays the body price and gets the booking', async () => {
    const before = await spendableSats(merchant)
    const price = 3 * ROOM_RATES_SATS.suite
    const res = await create402Fetch({ wallet: withHostOriginator(buyer) })(`${url}/api/hotel/book`, json({ roomType: 'suite', nights: 3 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.receipt).toMatchObject({ satoshisPaid: price })
    expect(body.order).toMatchObject({ roomType: 'suite', nights: 3, totalSats: price, bookingId: expect.any(String) })
    expect(await spendableSats(merchant)).toBe(before + price)
  })

  it('a payment for 1 night does not buy 3 nights', async () => {
    const headers = await constructPaymentHeaders(withHostOriginator(buyer), `${url}/api/hotel/book`, ROOM_RATES_SATS.suite, merchant.identityKey)
    const res = await fetch(`${url}/api/hotel/book`, withHeaders(json({ roomType: 'suite', nights: 3 }), headers))
    expect(res.status).toBe(402)
    expect(res.headers.get('x-bsv-sats')).toBe(String(3 * ROOM_RATES_SATS.suite))
  })
})
