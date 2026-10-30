/**
 * Demo merchant that sells to AI agents with BRC-121 Simple 402 Payments.
 * The server sets every price (guide §10.5): a fixed price for the report, and
 * nights x room rate for a hotel booking, computed here from the request body.
 * Paid answers carry a receipt (txid, satoshisPaid) and the order.
 */
import { randomUUID } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { WalletInterface } from '../shared/bsv.js'
import { createPaymentMiddleware, InMemoryPaymentReplayStore, type PaymentReplayStore, type PaymentResult } from '../shared/brc121.js'

export const REPORT_PRICE_SATS = 500
export const ROOM_RATES_SATS = { standard: 2_000, suite: 5_000 } as const
export const MAX_NIGHTS = 30
export type RoomType = keyof typeof ROOM_RATES_SATS

export interface CatalogEntry {
  name: string
  category: string
  method: 'GET' | 'POST'
  path: string
  /** Fixed price per request. */
  priceSats?: number
  /** Price per night by room type; the booking costs nights x rate. */
  priceSatsPerNight?: Record<RoomType, number>
}

export const CATALOG: CatalogEntry[] = [
  { name: 'Market report', category: 'data', method: 'GET', path: '/api/report', priceSats: REPORT_PRICE_SATS },
  { name: 'Hotel booking', category: 'travel', method: 'POST', path: '/api/hotel/book', priceSatsPerNight: { ...ROOM_RATES_SATS } }
]

export interface HotelBooking { roomType: RoomType, nights: number }

/** Validates a booking body; returns an error message or the booking. */
export function parseBooking (body: unknown): HotelBooking | string {
  const { roomType, nights } = (body ?? {}) as Record<string, unknown>
  if (typeof roomType !== 'string' || !Object.hasOwn(ROOM_RATES_SATS, roomType)) {
    return `roomType must be one of ${Object.keys(ROOM_RATES_SATS).join(', ')}`
  }
  if (!Number.isInteger(nights) || (nights as number) < 1 || (nights as number) > MAX_NIGHTS) {
    return `nights must be an integer from 1 to ${MAX_NIGHTS}`
  }
  return { roomType: roomType as RoomType, nights: nights as number }
}

export function bookingPrice (b: HotelBooking): number {
  return b.nights * ROOM_RATES_SATS[b.roomType]
}

export interface MerchantOptions {
  /** Atomic replay store; use a shared durable one with more than one process. */
  replayStore?: PaymentReplayStore
}

const receiptOf = (req: Request): { txid: string, satoshisPaid: number } => {
  const payment = (req as Request & { payment: PaymentResult }).payment
  return { txid: payment.txid, satoshisPaid: payment.satoshisPaid }
}

export function createMerchantApp (wallet: WalletInterface, opts: MerchantOptions = {}): Express {
  const replayStore = opts.replayStore ?? new InMemoryPaymentReplayStore()
  const app = express()

  app.get('/api/catalog', (_req, res) => { res.json({ items: CATALOG }) })

  app.get('/api/report',
    createPaymentMiddleware({ wallet, replayStore, calculatePrice: () => REPORT_PRICE_SATS }),
    (req, res) => {
      res.json({
        receipt: receiptOf(req),
        order: {
          reportId: randomUUID(),
          title: 'BSV agent payments market report',
          summary: 'Demo content: agents paid per request over HTTP 402.'
        }
      })
    })

  // createPaymentMiddleware's calculatePrice only sees the path, so the price is
  // computed from the parsed body first and handed to a per-request middleware.
  // An invalid body is refused before any payment is asked for.
  app.post('/api/hotel/book',
    express.json({ limit: '10kb' }),
    (req: Request, res: Response, next: NextFunction) => {
      const booking = parseBooking(req.body)
      if (typeof booking === 'string') { res.status(400).json({ error: booking }); return }
      res.locals.booking = booking
      const price = bookingPrice(booking)
      void createPaymentMiddleware({ wallet, replayStore, calculatePrice: () => price })(req, res, next).catch(next)
    },
    (req: Request, res: Response) => {
      const booking = res.locals.booking as HotelBooking
      res.json({
        receipt: receiptOf(req),
        order: { bookingId: randomUUID(), ...booking, totalSats: bookingPrice(booking) }
      })
    })

  return app
}
