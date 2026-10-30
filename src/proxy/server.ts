/**
 * Spend-control proxy: `npm run proxy`.
 * Env: PROXY_ROOT_KEY (64 hex chars), ADMIN_TOKEN (>= 16 chars), PROXY_PORT (default 5050), BSV_NETWORK,
 * PROXY_PUBLIC_URL (e.g. https://agentpay.example, for connection links), TRUST_PROXY=1 behind a reverse proxy.
 *
 * The proxy holds no funds. PROXY_ROOT_KEY only derives the policy key of each
 * vault (one of the two keys a payment needs) and the proxy's identity key.
 */
import 'dotenv/config'
import { ArcadeChainTracker } from '../shared/arcade.js'
import { PrivateKey } from '../shared/bsv.js'
import { arcadeUrl, getNetwork } from '../shared/network.js'
import { ArcadeBroadcaster } from '../vault/broadcaster.js'
import { createProxyApp } from './app.js'
import { CompositeNotifier, DashboardNotifier } from './notifier.js'
import { openProxyDb } from './store.js'

const port = Number(process.env.PROXY_PORT ?? 5050)
const adminToken = process.env.ADMIN_TOKEN ?? ''
if (adminToken.length < 16) throw new Error('ADMIN_TOKEN must be set (at least 16 characters)')
const rootKeyHex = process.env.PROXY_ROOT_KEY ?? ''
if (!/^[0-9a-fA-F]{64}$/.test(rootKeyHex)) throw new Error('PROXY_ROOT_KEY must be set to a 64-character hex private key')

const network = getNetwork()
const policyRootKey = PrivateKey.fromHex(rootKeyHex)
const db = await openProxyDb('./data/proxy.sqlite')

const app = createProxyApp({
  db,
  policyRootKey,
  chainTracker: new ArcadeChainTracker(arcadeUrl(network)),
  broadcaster: new ArcadeBroadcaster(arcadeUrl(network)),
  notifier: new CompositeNotifier([new DashboardNotifier()]),
  adminToken,
  network,
  publicUrl: process.env.PROXY_PUBLIC_URL === undefined || process.env.PROXY_PUBLIC_URL === '' ? undefined : process.env.PROXY_PUBLIC_URL,
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'
})
const server = app.listen(port, () => {
  console.log(`proxy on http://localhost:${port} (${network}), identity key ${policyRootKey.toPublicKey().toString()}`)
})

const shutdown = (): void => {
  server.close(() => { void db.destroy().then(() => process.exit(0)) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
