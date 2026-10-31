/**
 * Proxy test harness on the mock chain: a company wallet (funds vaults), the
 * proxy (policy key only, no funds), and agents with local keys.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'
import type { Knex } from 'knex'
import { PrivateKey } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { signVaultPayment, type VaultSignAnswer } from '../../src/agent/vault-signer'
import { fundVault } from '../../src/company/vault-client'
import { fingerprint } from '../../src/shared/fingerprint'
import { createProxyApp, notaryOf, type ProxyAppOptions } from '../../src/proxy/app'
import type { Notary, NotaryConfig } from '../../src/audit/notary'
import { DashboardNotifier, type Notifier } from '../../src/proxy/notifier'
import { openProxyDb } from '../../src/proxy/store'
import { createMockChain, type MockChain } from './mockchain'

export const ADMIN_TOKEN = 'test-admin-token-0123456789'

export interface Res { status: number, body: any }

export interface TestAgent {
  id: string
  /** The agent's API key (Bearer). */
  key: string
  /** The agent's own signing key; the proxy only ever sees its public key. */
  signer: PrivateKey
}

export interface ProxyHarness {
  chain: MockChain
  db: Knex
  company: Wallet
  policyRootKey: PrivateKey
  url: string
  /** The notary, if the harness was given a notary wallet (its scheduler is not started: tests call tick()). */
  notary: Notary | undefined
  /** Shifts the proxy's clock (ms), e.g. to make a signature late. */
  clock: { offset: number }
  listen: (app: Express) => Promise<string>
  call: (path: string, token: string | undefined, init?: { method?: string, body?: unknown }) => Promise<Res>
  admin: (path: string, init?: { method?: string, body?: unknown }) => Promise<Res>
  pay: (agent: TestAgent, body: unknown) => Promise<Res>
  /** Signs a 'sign' answer with the agent key (checked by the vault signer) and submits it. */
  sign: (agent: TestAgent, answer: VaultSignAnswer, expectedPriceSats: number) => Promise<Res>
  /** pay + sign in one go, for requests the rules allow. */
  payAndSign: (agent: TestAgent, body: unknown, expectedPriceSats: number) => Promise<Res>
  /** Creates an agent and connects it with its one-time code: its id and API key, nothing registered yet. */
  newAgent: (name: string, rules?: object) => Promise<{ id: string, apiKey: string }>
  /** Creates an agent, registers its key and, if `vaultSats` > 0, funds its vault from the company wallet. */
  createAgent: (name: string, rules: object, vaultSats?: number) => Promise<TestAgent>
  close: () => Promise<void>
}

export interface HarnessOptions {
  notifier?: Notifier
  /** A wallet (on this harness's mock chain: pass a function) to use as the notary. */
  notary?: { wallet: (chain: MockChain) => Promise<Wallet>, config?: Partial<NotaryConfig>, log?: (msg: string) => void }
  /** Extra proxy options, e.g. { vaultCovenant: true }. */
  app?: Pick<ProxyAppOptions, 'vaultCovenant' | 'anchorPayments' | 'log'>
}

export async function createProxyHarness (opts: HarnessOptions = {}): Promise<ProxyHarness> {
  const chain = await createMockChain()
  const company = await chain.makeWallet()
  await chain.fund(company, 2_000_000)
  const db = await openProxyDb(':memory:')
  const policyRootKey = PrivateKey.fromRandom()
  const clock = { offset: 0 }
  const servers: Server[] = []

  const listen = async (app: Express): Promise<string> => await new Promise(resolve => {
    const s = app.listen(0, () => resolve(`http://localhost:${(s.address() as AddressInfo).port}`))
    servers.push(s)
  })
  const notaryWallet = opts.notary === undefined ? undefined : await opts.notary.wallet(chain)
  const app = createProxyApp({
    db,
    policyRootKey,
    chainTracker: chain.chainTracker,
    broadcaster: chain.broadcaster,
    notifier: opts.notifier ?? new DashboardNotifier(),
    adminToken: ADMIN_TOKEN,
    network: 'test',
    now: () => Date.now() + clock.offset,
    // Every test connects from 127.0.0.1.
    connectRateLimit: { max: 10_000, windowMs: 60_000 },
    ...opts.app,
    notary: notaryWallet === undefined
      ? undefined
      : { wallet: notaryWallet, identityKey: notaryWallet.identityKey, config: opts.notary?.config, log: opts.notary?.log }
  })
  const url = await listen(app)

  const call = async (path: string, token: string | undefined, init: { method?: string, body?: unknown } = {}): Promise<Res> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${url}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const admin = async (path: string, init: { method?: string, body?: unknown } = {}): Promise<Res> => await call(path, ADMIN_TOKEN, init)
  const pay = async (agent: TestAgent, body: unknown): Promise<Res> => await call('/v1/pay', agent.key, { method: 'POST', body })
  const sign = async (agent: TestAgent, answer: VaultSignAnswer, expectedPriceSats: number): Promise<Res> =>
    await call(`/v1/requests/${answer.requestId}/sign`, agent.key, { method: 'POST', body: { signature: signVaultPayment(answer, agent.signer, expectedPriceSats) } })
  const payAndSign = async (agent: TestAgent, body: unknown, expectedPriceSats: number): Promise<Res> => {
    const res = await pay(agent, body)
    if (res.status !== 200 || res.body?.status !== 'sign') return res
    return await sign(agent, res.body, expectedPriceSats)
  }

  const newAgent = async (name: string, rules?: object): Promise<{ id: string, apiKey: string }> => {
    const created = await admin('/admin/agents', { method: 'POST', body: rules === undefined ? { name } : { name, rules } })
    if (created.status !== 201) throw new Error(`agent not created: ${JSON.stringify(created.body)}`)
    // The API key only exists once the agent exchanges its one-time code.
    const connected = await call('/v1/connect', undefined, { method: 'POST', body: { code: created.body.connectCode } })
    if (connected.status !== 200) throw new Error(`agent not connected: ${JSON.stringify(connected.body)}`)
    return { id: created.body.id, apiKey: connected.body.apiKey }
  }

  const createAgent = async (name: string, rules: object, vaultSats = 0): Promise<TestAgent> => {
    const created = await newAgent(name, rules)
    const agent: TestAgent = { id: created.id, key: created.apiKey, signer: PrivateKey.fromRandom() }
    const reg = await call('/v1/vault/agent-key', agent.key, { method: 'POST', body: { publicKey: agent.signer.toPublicKey().toString() } })
    if (reg.status !== 200) throw new Error(`agent key not registered: ${JSON.stringify(reg.body)}`)
    if (vaultSats > 0) await fundVault(company, url, ADMIN_TOKEN, agent.id, vaultSats, fp(agent))
    return agent
  }

  return {
    chain,
    db,
    company,
    policyRootKey,
    url,
    notary: notaryOf(app),
    clock,
    listen,
    call,
    admin,
    pay,
    sign,
    payAndSign,
    newAgent,
    createAgent,
    close: async () => {
      for (const s of servers) await new Promise(resolve => s.close(resolve))
      await db.destroy()
      await chain.close()
    }
  }
}

/** The agent key fingerprint, as a human reads it on the agent's machine and confirms before funding. */
export const fp = (agent: TestAgent): string => fingerprint(agent.signer.toPublicKey().toString())

export const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
