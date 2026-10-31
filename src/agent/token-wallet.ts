import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  Monitor,
  Services,
  Setup,
  StorageKnex,
  Wallet,
  WalletStorageManager
} from '@bsv/wallet-toolbox'
import { CachedKeyDeriver, type PrivateKey } from '../shared/bsv.js'
import { arcadeUrl, getNetwork, type BsvNetwork } from '../shared/network.js'

export interface AgentTokenWallet {
  wallet: Wallet
  identityKey: string
  close: () => Promise<void>
}

export async function openAgentTokenWallet (
  rootKey: PrivateKey,
  filePath: string,
  network: BsvNetwork = getNetwork()
): Promise<AgentTokenWallet> {
  const identityKey = rootKey.toPublicKey().toString()
  const options = Services.createDefaultOptions(network)
  options.arcadeUrl = arcadeUrl(network)
  const services = new Services(options)

  mkdirSync(dirname(filePath), { recursive: true })
  const storage = new StorageKnex({
    ...StorageKnex.createStorageBaseOptions(network),
    knex: Setup.createSQLiteKnex(filePath)
  })
  await storage.migrate('agenttresor-agent-token-wallet', identityKey)
  await storage.makeAvailable()

  const manager = new WalletStorageManager(identityKey, storage)
  await manager.makeAvailable()
  manager.setServices(services)

  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(network, manager, services))
  monitor.addDefaultTasks()
  monitor.startTasks()

  const wallet = new Wallet({
    chain: network,
    keyDeriver: new CachedKeyDeriver(rootKey),
    storage: manager,
    services,
    monitor
  })

  return {
    wallet,
    identityKey,
    close: async () => {
      monitor.stopTasks()
      await monitor.destroy()
      await wallet.destroy()
    }
  }
}