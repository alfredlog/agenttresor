/**
 * Spend-control proxy: `npm run proxy`.
 * Env: PROXY_ROOT_KEY (64 hex chars), ADMIN_TOKEN (>= 16 chars), PROXY_PORT (default 5050), BSV_NETWORK.
 * In block 3 the proxy pays from its own server wallet; fund it by paying its identity key.
 */
import 'dotenv/config'
import { openServerWallet } from '../shared/wallet.js'
import { createProxyApp } from './app.js'
import { CompositeNotifier, DashboardNotifier } from './notifier.js'
import { WalletPayer } from './payer.js'
import { openProxyDb } from './store.js'

const port = Number(process.env.PROXY_PORT ?? 5050)
const adminToken = process.env.ADMIN_TOKEN ?? ''
if (adminToken.length < 16) throw new Error('ADMIN_TOKEN must be set (at least 16 characters)')

const db = await openProxyDb('./data/proxy.sqlite')
const { wallet, monitor, identityKey, network, close } = await openServerWallet({
  rootKeyEnv: 'PROXY_ROOT_KEY',
  filePath: './data/proxy-wallet.sqlite'
})
monitor.startTasks().catch(err => { console.error('wallet monitor stopped:', err) })

const app = createProxyApp({
  db,
  payer: new WalletPayer(wallet),
  notifier: new CompositeNotifier([new DashboardNotifier()]),
  adminToken,
  network
})
const server = app.listen(port, () => {
  console.log(`proxy on http://localhost:${port} (${network}), wallet identity key ${identityKey}`)
})

const shutdown = (): void => {
  server.close(() => { void close().then(async () => { await db.destroy(); process.exit(0) }) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
