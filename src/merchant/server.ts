/**
 * Demo merchant server: `npm run merchant`.
 * Env: MERCHANT_ROOT_KEY (64 hex chars), MERCHANT_PORT (default 5080), BSV_NETWORK.
 */
import 'dotenv/config'
import { openServerWallet } from '../shared/wallet.js'
import { createMerchantApp } from './app.js'

const port = Number(process.env.MERCHANT_PORT ?? 5080)
const { wallet, monitor, identityKey, network, close } = await openServerWallet({
  rootKeyEnv: 'MERCHANT_ROOT_KEY',
  filePath: './data/merchant-wallet.sqlite'
})
monitor.startTasks().catch(err => { console.error('wallet monitor stopped:', err) })

const server = createMerchantApp(wallet).listen(port, () => {
  console.log(`merchant on http://localhost:${port} (${network}), identity key ${identityKey}`)
})

const shutdown = (): void => { server.close(() => { void close().then(() => process.exit(0)) }) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
