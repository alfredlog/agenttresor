/**
 * The notary (option B): the OPERATOR's own small fee wallet, never company
 * funds. Vault payments anchor the audit log as they go (option A); when the
 * log has entries no anchor covers and nothing has happened for a while, the
 * notary anchors the head itself, so every event ends up on chain even without
 * payments. The dashboard's "Anchor now" button (company wallet) still works.
 *
 * What the notary can do: create anchor transactions (one 0-sat OP_RETURN
 * output; its wallet adds the fee input and change) and receive top-ups. It
 * holds no vault key, so it cannot move company or agent funds: the worst case
 * is losing its own small balance (at most NOTARY_MAX_SATS).
 */
import { P2PKH, PublicKey, Transaction, Utils, type ChainTracker, type WalletInterface, type WalletProtocol } from '../shared/bsv.js'
import { ProxyError } from '../proxy/errors.js'
import type { Notifier } from '../proxy/notifier.js'
import { anchorLockingScript } from './anchor-script.js'
import type { AuditAnchor, AuditLog } from './log.js'

const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

export interface NotaryConfig {
  /** Anchor only once the newest entry is this old (ANCHOR_IDLE_MS, default 120 s). */
  idleMs: number
  /** How often the scheduler looks (default 30 s). */
  intervalMs: number
  /** Alert when fewer anchors than this are left (NOTARY_LOW_ANCHORS, default 20). */
  lowAnchors: number
  /** The notary never holds more than this (NOTARY_MAX_SATS, default 20000). */
  maxSats: number
  /** Cost of one anchor until the notary has made some (default 30 sats). */
  defaultAnchorCostSats: number
}

export const DEFAULT_NOTARY_CONFIG: NotaryConfig = { idleMs: 120_000, intervalMs: 30_000, lowAnchors: 20, maxSats: 20_000, defaultAnchorCostSats: 30 }

/** How many of the newest notary anchors the cost estimate averages. */
const COST_SAMPLE = 10

export interface NotaryOptions {
  wallet: WalletInterface
  identityKey: string
  audit: AuditLog
  /** Verifies top-up transactions (SPV). */
  chainTracker: ChainTracker
  /** A vault payment is being built: it will carry its own anchor, so the notary waits. */
  paymentInFlight: () => Promise<boolean>
  notifier: Notifier
  now: () => number
  log?: (msg: string) => void
  config?: Partial<NotaryConfig>
}

/** ok, low (fewer than `lowAnchors` left: orange), empty (no anchor left: red). */
export type NotaryLevel = 'ok' | 'low' | 'empty'
const SEVERITY: Record<NotaryLevel, number> = { ok: 0, low: 1, empty: 2 }

export interface NotaryStatus {
  identityKey: string
  balanceSats: number
  avgAnchorCostSats: number
  anchorsLeft: number
  level: NotaryLevel
  /** The last anchor failed for lack of funds (cleared by a top-up or a successful anchor). */
  outOfFunds: boolean
  lowAnchors: number
  maxSats: number
  /** How much a top-up may add without the balance going over `maxSats`. */
  topUpRoomSats: number
  idleMs: number
  anchoring: boolean
  lastError: string | null
}

/** What lowNotaryBalance tells humans (no keys). */
export interface NotaryAlert {
  level: 'low' | 'empty'
  balanceSats: number
  anchorsLeft: number
  message: string
}

export type NotaryTick = { anchored: AuditAnchor } | { skipped: string }

export interface TopUpBody {
  beef?: unknown
  outputIndex?: unknown
  derivationPrefix?: unknown
  derivationSuffix?: unknown
  senderIdentityKey?: unknown
}

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)
const isInsufficientFunds = (err: unknown): boolean =>
  (err as { name?: string, code?: string })?.name === 'WERR_INSUFFICIENT_FUNDS' ||
  (err as { code?: string })?.code === 'WERR_INSUFFICIENT_FUNDS' ||
  /insufficient funds/i.test(errorMessage(err))
const isBase64 = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)

export function alertMessage (level: 'low' | 'empty', anchorsLeft: number): string {
  return level === 'empty'
    ? 'Notary out of funds: no anchors left — top up from BSV Desktop'
    : `Notary: about ${anchorsLeft} anchors left — top up from BSV Desktop`
}

export class Notary {
  readonly identityKey: string
  readonly config: NotaryConfig
  private readonly wallet: WalletInterface
  private readonly audit: AuditLog
  private readonly chainTracker: ChainTracker
  private readonly paymentInFlight: () => Promise<boolean>
  private readonly notifier: Notifier
  private readonly now: () => number
  private readonly log: (msg: string) => void

  private anchoring = false
  private outOfFunds = false
  private lastError: string | null = null
  /** The level the last alert was sent for; read from the audit log on first use, so a restart does not alert again. */
  private alerted: NotaryLevel | undefined
  private timer: NodeJS.Timeout | undefined
  /** Balance checks run one at a time, so two concurrent checks cannot both send the same alert. */
  private checking: Promise<unknown> = Promise.resolve()

  constructor (opts: NotaryOptions) {
    this.wallet = opts.wallet
    this.identityKey = opts.identityKey
    this.audit = opts.audit
    this.chainTracker = opts.chainTracker
    this.paymentInFlight = opts.paymentInFlight
    this.notifier = opts.notifier
    this.now = opts.now
    this.log = opts.log ?? (() => {})
    this.config = { ...DEFAULT_NOTARY_CONFIG, ...opts.config }
  }

  /** Runs tick() every `intervalMs` until stop(). Errors are logged, never thrown. */
  start (): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.tick().catch(err => { this.log(`notary: ${errorMessage(err)}`) })
    }, this.config.intervalMs)
    this.timer.unref()
  }

  stop (): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * One scheduler step: anchors the head if entries are unanchored, the newest
   * is older than `idleMs`, no vault payment is being built, and no other
   * notary anchor is in flight.
   */
  async tick (): Promise<NotaryTick> {
    if (this.anchoring) return { skipped: 'an anchor is already in flight' }
    this.anchoring = true
    try {
      const head = await this.audit.status()
      if (head.unanchoredEntries === 0) return { skipped: 'nothing to anchor' }
      // A log shorter than an anchor lost its newest entries: anchoring it would only bury the alert.
      if (head.chainShorterThanAnchor) return { skipped: 'the log is shorter than an existing anchor' }
      if (this.now() - await this.audit.headAt() < this.config.idleMs) return { skipped: 'entries are still fresh' }
      if (await this.paymentInFlight()) return { skipped: 'a vault payment is being built' }
      if ((await this.balanceSats()) === 0) {
        this.markOutOfFunds('the balance is 0')
        await this.checkBalance()
        return { skipped: 'out of funds' }
      }
      return await this.anchorHead()
    } finally {
      this.anchoring = false
    }
  }

  /** Balance, estimated anchors left and alert level; sends the low-balance alert when a threshold is crossed. */
  async status (): Promise<NotaryStatus> {
    return await this.checkBalance()
  }

  /** The notary's spendable satoshis. */
  async balanceSats (): Promise<number> {
    const { outputs } = await this.wallet.listOutputs({ basket: 'default', limit: 10_000 })
    return outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  }

  /**
   * POST /admin/notary/topup: a BRC-29 payment from the company's wallet to the
   * notary's identity key. Checked by SPV and by the derived key, capped so the
   * balance stays at most `maxSats`, then internalized as a 'wallet payment'.
   */
  async acceptTopUp (body: TopUpBody): Promise<{ txid: string, satoshis: number, balanceSats: number }> {
    if (typeof body.beef !== 'string' || !/^([0-9a-f]{2})+$/i.test(body.beef)) throw new ProxyError(400, 'beef must be AtomicBEEF hex')
    if (!Number.isSafeInteger(body.outputIndex) || (body.outputIndex as number) < 0) throw new ProxyError(400, 'outputIndex must be an output index')
    if (!isBase64(body.derivationPrefix) || !isBase64(body.derivationSuffix)) throw new ProxyError(400, 'derivationPrefix and derivationSuffix must be base64')
    if (typeof body.senderIdentityKey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(body.senderIdentityKey)) throw new ProxyError(400, 'senderIdentityKey must be a compressed public key')
    const outputIndex = body.outputIndex as number
    const beef = Utils.toArray(body.beef, 'hex')

    let tx: Transaction
    try {
      tx = Transaction.fromAtomicBEEF(beef)
    } catch (err) {
      throw new ProxyError(400, `beef is not valid AtomicBEEF: ${errorMessage(err)}`)
    }
    let valid = false
    try { valid = await tx.verify(this.chainTracker) } catch {}
    if (!valid) throw new ProxyError(400, 'the top-up transaction failed SPV verification')

    // Recipient side of BRC-29: counterparty = the sender, forSelf: true.
    const { publicKey } = await this.wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${body.derivationPrefix} ${body.derivationSuffix}`,
      counterparty: body.senderIdentityKey,
      forSelf: true
    })
    const output = tx.outputs[outputIndex]
    if (output === undefined || output.lockingScript.toHex() !== new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()) {
      throw new ProxyError(400, 'the output is not a BRC-29 payment to the notary')
    }
    const satoshis = output.satoshis ?? 0
    if (satoshis < 1) throw new ProxyError(400, 'the top-up holds no satoshis')
    const room = Math.max(0, this.config.maxSats - await this.balanceSats())
    if (satoshis > room) throw new ProxyError(400, `the notary keeps at most ${this.config.maxSats} sats; this top-up may add ${room}`, { code: 'NOTARY_CAP' })

    await this.wallet.internalizeAction({
      tx: beef,
      outputs: [{
        outputIndex,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix: body.derivationPrefix, derivationSuffix: body.derivationSuffix, senderIdentityKey: body.senderIdentityKey }
      }],
      description: 'AgentTresor notary top-up'
    })
    const txid = tx.id('hex')
    const balanceSats = await this.balanceSats()
    this.outOfFunds = false
    await this.audit.append('company', 'notary.topped_up', { txid, satoshis, balanceSats })
    this.log(`notary topped up with ${satoshis} sats (balance ${balanceSats})`)
    await this.checkBalance()
    return { txid, satoshis, balanceSats }
  }

  private async anchorHead (): Promise<NotaryTick> {
    const { seq, hash } = await this.audit.head()
    const lockingScript = anchorLockingScript(hash, seq).toHex()
    let txid: string
    let feeSats: number | null = null
    try {
      const created = await this.wallet.createAction({
        description: `Anchor AgentTresor audit log #${seq}`.slice(0, 50),
        outputs: [{ lockingScript, satoshis: 0, outputDescription: 'AgentTresor audit anchor' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      if (created.txid === undefined || created.tx === undefined) throw new Error('the notary wallet did not create the anchor transaction')
      const failed = created.sendWithResults?.find(r => r.status === 'failed')
      if (failed !== undefined) throw new Error(`broadcast of ${failed.txid} failed`)
      txid = created.txid
      try { feeSats = Transaction.fromAtomicBEEF(created.tx).getFee() } catch {}
    } catch (err) {
      if (isInsufficientFunds(err)) {
        this.markOutOfFunds(errorMessage(err))
        await this.checkBalance()
        return { skipped: 'out of funds' }
      }
      this.lastError = errorMessage(err)
      this.log(`notary: anchor of #${seq} failed: ${this.lastError}`)
      return { skipped: `anchor failed: ${this.lastError}` }
    }

    const anchor: AuditAnchor = { seq, hash, txid, at: this.now(), source: 'notary', feeSats }
    await this.audit.transaction(async a => {
      await a.addAnchor(anchor)
      await a.append('notary', 'audit.anchor_recorded', { seq, hash, txid, source: 'notary', feeSats })
    })
    this.outOfFunds = false
    this.lastError = null
    this.log(`notary anchored audit log #${seq} in ${txid}${feeSats === null ? '' : ` (fee ${feeSats} sats)`}`)
    await this.checkBalance()
    return { anchored: anchor }
  }

  /** Logs "out of funds" once per episode; payments and manual anchors keep working. */
  private markOutOfFunds (why: string): void {
    if (!this.outOfFunds) this.log(`notary out of funds (${why}): idle anchoring paused until a top-up; payments and manual anchors still work`)
    this.outOfFunds = true
  }

  private async checkBalance (): Promise<NotaryStatus> {
    const run = this.checking.catch(() => {}).then(async () => await this.computeStatus())
    this.checking = run
    return await run
  }

  private async computeStatus (): Promise<NotaryStatus> {
    const balanceSats = await this.balanceSats()
    const fees = await this.audit.anchorFees('notary', COST_SAMPLE)
    const avgAnchorCostSats = fees.length === 0 ? this.config.defaultAnchorCostSats : Math.max(1, Math.ceil(fees.reduce((s, f) => s + f, 0) / fees.length))
    const anchorsLeft = Math.floor(balanceSats / avgAnchorCostSats)
    const level: NotaryLevel = this.outOfFunds || anchorsLeft === 0 ? 'empty' : anchorsLeft < this.config.lowAnchors ? 'low' : 'ok'
    await this.alertOnCrossing(level, balanceSats, anchorsLeft)
    return {
      identityKey: this.identityKey,
      balanceSats,
      avgAnchorCostSats,
      anchorsLeft,
      level,
      outOfFunds: this.outOfFunds,
      lowAnchors: this.config.lowAnchors,
      maxSats: this.config.maxSats,
      topUpRoomSats: Math.max(0, this.config.maxSats - balanceSats),
      idleMs: this.config.idleMs,
      anchoring: this.anchoring,
      lastError: this.lastError
    }
  }

  /**
   * Alerts (Notifier + one audit entry) when the level gets worse: ok → low,
   * low → empty. Getting better (a top-up) re-arms the alert; checking again at
   * the same level does nothing.
   */
  private async alertOnCrossing (level: NotaryLevel, balanceSats: number, anchorsLeft: number): Promise<void> {
    if (this.alerted === undefined) {
      const last = await this.audit.latestOfType(['notary.low_balance', 'notary.topped_up'])
      this.alerted = last?.type === 'notary.low_balance' ? (last.data.level as NotaryLevel) : 'ok'
    }
    if (SEVERITY[level] <= SEVERITY[this.alerted]) {
      this.alerted = level
      return
    }
    this.alerted = level
    const alert: NotaryAlert = { level: level as 'low' | 'empty', balanceSats, anchorsLeft, message: alertMessage(level as 'low' | 'empty', anchorsLeft) }
    await this.audit.append('notary', 'notary.low_balance', { level: alert.level, balanceSats, anchorsLeft, lowAnchors: this.config.lowAnchors })
    this.log(alert.message)
    try {
      await this.notifier.lowNotaryBalance(alert)
    } catch (err) {
      this.log(`notary: low-balance notification failed: ${errorMessage(err)}`)
    }
  }
}
