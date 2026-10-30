/**
 * Server wallet (wallet-toolbox, SQLite) with Arcade as the primary broadcaster
 * and merkle-proof provider (guide §14.2). The root key comes from an
 * environment variable and is never logged.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Monitor, Services, Setup, StorageKnex, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox'
import { CachedKeyDeriver, PrivateKey } from './bsv.js'
import { arcadeUrl, getNetwork, type BsvNetwork } from './network.js'

export interface ServerWalletOptions {
  /** Name of the env variable holding the 64-hex-char root key. */
  rootKeyEnv?: string
  /** SQLite database file. */
  filePath?: string
  network?: BsvNetwork
}

export interface ServerWallet {
  wallet: Wallet
  monitor: Monitor
  identityKey: string
  network: BsvNetwork
  /** Stops the monitor and closes the database. */
  close: () => Promise<void>
}

export async function openServerWallet (opts: ServerWalletOptions = {}): Promise<ServerWallet> {
  const { rootKeyEnv = 'SERVER_PRIVATE_KEY', filePath = './data/server-wallet.sqlite', network = getNetwork() } = opts
  const rootKeyHex = process.env[rootKeyEnv]
  if (rootKeyHex === undefined || !/^[0-9a-fA-F]{64}$/.test(rootKeyHex)) {
    throw new Error(`${rootKeyEnv} must be set to a 64-character hex private key`)
  }
  const rootKey = PrivateKey.fromHex(rootKeyHex)
  const identityKey = rootKey.toPublicKey().toString()

  const options = Services.createDefaultOptions(network)
  options.arcadeUrl = arcadeUrl(network)
  const services = new Services(options) // broadcast order: Arcade, GorillaPool, TAAL, Bitails, WhatsOnChain

  mkdirSync(dirname(filePath), { recursive: true })
  const storage = new StorageKnex({ ...StorageKnex.createStorageBaseOptions(network), knex: Setup.createSQLiteKnex(filePath) })
  await storage.migrate('agenttresor-wallet', identityKey)
  await storage.makeAvailable()
  const manager = new WalletStorageManager(identityKey, storage)
  await manager.makeAvailable()
  manager.setServices(services)

  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(network, manager, services))
  monitor.addDefaultTasks() // tracks proofs, retries broadcasts; call monitor.startTasks() in a long-running server
  const wallet = new Wallet({ chain: network, keyDeriver: new CachedKeyDeriver(rootKey), storage: manager, services, monitor })

  return {
    wallet,
    monitor,
    identityKey,
    network,
    close: async () => {
      monitor.stopTasks()
      await monitor.destroy()
      await wallet.destroy()
    }
  }
}
