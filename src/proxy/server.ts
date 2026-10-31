/**
 * Spend-control proxy: `npm run proxy`.
 * Env: PROXY_ROOT_KEY (64 hex chars), ADMIN_TOKEN (>= 16 chars), PROXY_PORT (default 5050), BSV_NETWORK,
 * PROXY_PUBLIC_URL (e.g. https://agentpay.example, for connection links), TRUST_PROXY=1 behind a reverse proxy.
 * Anchoring: AUTO_ANCHOR_PAYMENTS (default true), AUTO_ANCHOR_NOTARY (default true), NOTARY_ROOT_KEY
 * (64 hex chars; missing = no notary), ANCHOR_IDLE_MS (120000), NOTARY_LOW_ANCHORS (20), NOTARY_MAX_SATS (20000).
 *
 * The proxy holds no company funds. PROXY_ROOT_KEY only derives the policy key
 * of each vault (one of the two keys a payment needs) and the proxy's identity
 * key. NOTARY_ROOT_KEY is the operator's own small fee wallet for anchors.
 */
import 'dotenv/config'
import { ArcadeChainTracker } from '../shared/arcade.js'
import { PrivateKey } from '../shared/bsv.js'
import { arcadeUrl, getNetwork } from '../shared/network.js'
import { openServerWallet, type ServerWallet } from '../shared/wallet.js'
import { ArcadeBroadcaster } from '../vault/broadcaster.js'
import { createProxyApp, notaryOf } from './app.js'
import { CompositeNotifier, DashboardNotifier } from './notifier.js'
import { openProxyDb } from './store.js'

const flag = (name: string, fallback: boolean): boolean => {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  return v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v)
}
const positiveInt = (name: string, fallback: number): number => {
  const v = (process.env[name] ?? '').trim()
  if (v === '') return fallback
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  return n
}

const port = Number(process.env.PROXY_PORT ?? 5050)
const adminToken = process.env.ADMIN_TOKEN ?? ''
if (adminToken.length < 16) throw new Error('ADMIN_TOKEN must be set (at least 16 characters)')
const rootKeyHex = process.env.PROXY_ROOT_KEY ?? ''
if (!/^[0-9a-fA-F]{64}$/.test(rootKeyHex)) throw new Error('PROXY_ROOT_KEY must be set to a 64-character hex private key')

const network = getNetwork()
const policyRootKey = PrivateKey.fromHex(rootKeyHex)
const db = await openProxyDb('./data/proxy.sqlite')
const log = (msg: string): void => { console.log(`${new Date().toISOString()} ${msg}`) }

// The notary (option B): the operator's own fee wallet, opened only if enabled and keyed.
let notaryWallet: ServerWallet | undefined
let notaryDisabledReason: string | undefined
if (!flag('AUTO_ANCHOR_NOTARY', true)) {
  notaryDisabledReason = 'AUTO_ANCHOR_NOTARY is off'
} else if ((process.env.NOTARY_ROOT_KEY ?? '').trim() === '') {
  notaryDisabledReason = 'NOTARY_ROOT_KEY is not set'
} else {
  notaryWallet = await openServerWallet({ rootKeyEnv: 'NOTARY_ROOT_KEY', filePath: './data/notary-wallet.sqlite', network })
  // The wallet's monitor retries broadcasts and collects merkle proofs for its anchors.
  void notaryWallet.monitor.startTasks()
}
if (notaryDisabledReason !== undefined) log(`notary disabled: ${notaryDisabledReason} (payments and the dashboard's Anchor button still anchor the log)`)

const app = createProxyApp({
  db,
  policyRootKey,
  chainTracker: new ArcadeChainTracker(arcadeUrl(network)),
  broadcaster: new ArcadeBroadcaster(arcadeUrl(network)),
  notifier: new CompositeNotifier([new DashboardNotifier()]),
  adminToken,
  network,
  publicUrl: process.env.PROXY_PUBLIC_URL === undefined || process.env.PROXY_PUBLIC_URL === '' ? undefined : process.env.PROXY_PUBLIC_URL,
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  anchorPayments: flag('AUTO_ANCHOR_PAYMENTS', true),
  notaryDisabledReason,
  notary: notaryWallet === undefined
    ? undefined
    : {
        wallet: notaryWallet.wallet,
        identityKey: notaryWallet.identityKey,
        log,
        config: {
          idleMs: positiveInt('ANCHOR_IDLE_MS', 120_000),
          lowAnchors: positiveInt('NOTARY_LOW_ANCHORS', 20),
          maxSats: positiveInt('NOTARY_MAX_SATS', 20_000)
        }
      }
})
const notary = notaryOf(app)
if (notary !== undefined) {
  notary.start()
  const s = await notary.status()
  log(`notary ${notary.identityKey}: ${s.balanceSats} sats, about ${s.anchorsLeft} anchors left; anchors the log after ${s.idleMs / 1000} s idle`)
}
const server = app.listen(port, () => {
  console.log(`proxy on http://localhost:${port} (${network}), identity key ${policyRootKey.toPublicKey().toString()}`)
})

const shutdown = (): void => {
  notary?.stop()
  server.close(() => {
    void Promise.resolve(notaryWallet?.close()).catch(() => {}).then(async () => { await db.destroy() }).then(() => process.exit(0))
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
