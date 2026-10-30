/**
 * Offline test harness: wallet-toolbox's mock chain plus real wallet-toolbox
 * wallets (the same wallet engine BSV Desktop runs).
 *
 * Two MockServices behaviours (wallet-toolbox 2.14.9) differ from a real
 * broadcaster and are patched here, test-only:
 *  1. Re-broadcasting a transaction the network already has is a success on
 *     ARC/Arcade ("already known"); MockServices treats it as a double spend
 *     of its own inputs. A recipient's wallet re-broadcasts on internalizeAction.
 *  2. hydrateInputSourcesFromBeef parses a fresh Transaction per input but marks
 *     parents visited by txid, so a tx spending two outputs of the same parent
 *     (e.g. a token + the sats change of the deploy) leaves the second copy
 *     without its own sources and script verification fails. Fixed by sharing
 *     one Transaction instance per txid.
 */
import { knex as makeKnex, type Knex } from 'knex'
import { Beef, CachedKeyDeriver, MerklePath, PrivateKey, Script, Transaction, type ChainTracker } from '@bsv/sdk'
import {
  MockServices,
  ScriptTemplateBRC29,
  StorageKnex,
  Wallet,
  WalletStorageManager,
  randomBytesBase64,
  randomBytesHex
} from '@bsv/wallet-toolbox'

export const memoryKnex = (): Knex => makeKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })

export interface MockChain {
  services: MockServices
  chainTracker: ChainTracker
  makeWallet: (rootKey?: PrivateKey) => Promise<Wallet>
  fund: (wallet: Wallet, satoshis?: number) => Promise<void>
  mineBlock: () => Promise<void>
  close: () => Promise<void>
}

export async function createMockChain (): Promise<MockChain> {
  const chainDb = memoryKnex()
  const services = new MockServices(chainDb)
  await services.initialize()
  for (let i = 0; i < 110; i++) await services.mineBlock()

  const postBeef = services.postBeef.bind(services)
  ;(services as any).postBeef = async (beef: Beef, txids: string[]) => {
    const results = []
    for (const txid of txids) {
      const known = await (services as any).storage.getTransaction(txid)
      results.push(known != null
        ? { name: 'MockServices', status: 'success', txidResults: [{ txid, status: 'success', alreadyKnown: true }] }
        : (await postBeef(beef, [txid]))[0])
    }
    return results
  }
  ;(services as any).hydrateInputSourcesFromBeef = (tx: Transaction, beef: Beef) => {
    const cache = new Map<string, Transaction>()
    const walk = (t: Transaction): void => {
      for (const input of t.inputs) {
        if (input.sourceTransaction !== undefined || input.sourceTXID === undefined) continue
        let source = cache.get(input.sourceTXID)
        if (source === undefined) {
          const raw = beef.findTxid(input.sourceTXID)?.rawTx
          if (raw === undefined) continue
          source = Transaction.fromBinary(Array.from(raw))
          cache.set(input.sourceTXID, source)
          walk(source)
        }
        input.sourceTransaction = source
      }
    }
    walk(tx)
  }

  const cleanups: Array<() => Promise<void>> = []

  async function makeWallet (rootKey = PrivateKey.fromRandom()): Promise<Wallet> {
    const db = memoryKnex()
    const provider = new StorageKnex({ chain: 'mock', knex: db, commissionSatoshis: 0, feeModel: { model: 'sat/kb', value: 100 } })
    await provider.migrate('bsv21kit-e2e', randomBytesHex(33))
    await provider.makeAvailable()
    const storage = new WalletStorageManager(rootKey.toPublicKey().toString(), provider)
    await storage.makeAvailable()
    storage.setServices(services)
    const wallet = new Wallet({ chain: 'mock', keyDeriver: new CachedKeyDeriver(rootKey), storage, services, actionBatchMode: 'legacy' } as any)
    cleanups.push(async () => { await wallet.destroy(); await db.destroy() })
    return wallet
  }

  /** Fund a wallet from a mature mock-chain coinbase (pattern from wallet-toolbox's own tests). */
  async function fund (wallet: Wallet, satoshis = 1_000_000): Promise<void> {
    const height = await services.getHeight()
    const [utxo] = await (services as any).storage.knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null }).where('blockHeight', '<=', height - 100).orderBy('blockHeight', 'asc').limit(1)
    const sourceRawTx = Array.from((await (services as any).storage.getTransaction(utxo.txid)).rawTx as number[])
    const derivationPrefix = randomBytesBase64(16)
    const derivationSuffix = randomBytesBase64(16)
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: wallet.keyDeriver })
    const payment = new Transaction()
    payment.addInput({ sourceTransaction: Transaction.fromBinary(sourceRawTx), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff })
    payment.addOutput({ satoshis, lockingScript: template.lock(keys.privateKey, keys.publicKey) })
    const txid = payment.id('hex')
    const sourceProof = (await services.getMerklePath(utxo.txid)).merklePath as MerklePath
    const unproven = new Beef()
    unproven.mergeRawTx(sourceRawTx, unproven.mergeBump(sourceProof))
    unproven.mergeRawTx(payment.toBinary())
    await services.postBeef(unproven, [txid])
    await services.mineBlock()
    const beef = new Beef()
    beef.mergeRawTx(payment.toBinary(), beef.mergeBump((await services.getMerklePath(txid)).merklePath as MerklePath))
    await wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid),
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: wallet.identityKey } }],
      description: 'Fund test wallet'
    })
  }

  return {
    services,
    chainTracker: await services.getChainTracker() as ChainTracker,
    makeWallet,
    fund,
    mineBlock: async () => { await services.mineBlock() },
    close: async () => {
      for (const c of cleanups.reverse()) await c()
      await chainDb.destroy()
    }
  }
}
