/**
 * Vault v2 end to end on the mock chain (which validates scripts like a node):
 * the company funds a v2 vault, the agent makes 3 payments with audit anchors,
 * the company reclaims the rest. Also measures what v2 costs per payment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LockingScript, PrivateKey, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { signVaultPayment, type VaultSignAnswer } from '../src/agent/vault-signer'
import { parseAnchorScript } from '../src/audit/anchor-script'
import { reclaimVault } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS } from '../src/merchant/app'
import { buildVaultPayment, PLACEHOLDER_ANCHOR } from '../src/vault/builder'
import { covenantLockingScript, isGroundS, parseCovenantScript, pushTxS } from '../src/vault/covenant'
import { vaultLockingScript, vaultPreimage } from '../src/vault/script'
import { ADMIN_TOKEN, createProxyHarness, spendableSats, type ProxyHarness } from './helpers/proxy'

let h: ProxyHarness
let merchant: string
let merchantWallet: Wallet
const logs: string[] = []
const CAP = 5_000

const rules = (max = CAP): object => ({ allowedHosts: [new URL(merchant).host], maxPerPaymentSats: max, dailyBudgetSats: 100_000, approvalThresholdSats: 10_000 })
const report = (): object => ({ url: `${merchant}/api/report`, purpose: 'Market report' })

beforeAll(async () => {
  h = await createProxyHarness({ app: { vaultCovenant: true, log: m => logs.push(m) } })
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
})
afterAll(async () => { await h?.close() })

describe('vault v2 on the mock chain', () => {
  it('fund v2 → 3 payments with anchors → the company reclaims the rest', async () => {
    const agent = await h.createAgent('covenant-bot', rules(), 30_000)

    // Funded as v2, capped at the agent's maxPerPaymentSats.
    const vault = await h.db('vaults').where({ agent_id: agent.id }).first()
    const caps = { maxSats: CAP, maxFeeSats: 1_000 }
    expect(parseCovenantScript(vault.locking_script)).toMatchObject({ agentPub: agent.signer.toPublicKey().toString(), ...caps })
    expect((await h.admin('/admin/vaults')).body.vaults.find((v: any) => v.agentId === agent.id)).toMatchObject({ status: 'open', satoshis: 30_000, covenant: caps })
    expect((await h.admin('/admin/agents')).body.agents.find((a: any) => a.id === agent.id).vault).toMatchObject({ covenant: caps })
    const funded = (await h.admin('/admin/audit?limit=1000')).body.entries.find((e: any) => e.type === 'vault.funded' && e.data.agentId === agent.id)
    expect(funded.data).toMatchObject({ covenant: caps, satoshis: 30_000 })

    const merchantBefore = await spendableSats(merchantWallet)
    let remaining = 30_000
    for (let i = 0; i < 3; i++) {
      const built = await h.pay(agent, report())
      expect(built.body.status).toBe('sign')
      const answer = built.body as VaultSignAnswer
      const tx = Transaction.fromHex(answer.unsignedTx)
      // [merchant, change to the same v2 script, anchor]; nLockTime ground for OP_PUSH_TX.
      expect(tx.outputs).toHaveLength(3)
      expect(tx.outputs[1].lockingScript.toHex()).toBe(answer.sourceLockingScript)
      expect(parseAnchorScript(tx.outputs[2].lockingScript)).toBeDefined()
      expect(isGroundS(pushTxS(vaultPreimage(tx, 0, answer.sourceSatoshis, LockingScript.fromHex(answer.sourceLockingScript))))).toBe(true)

      // The mock chain runs the covenant like a node would before accepting the payment.
      const paid = await h.sign(agent, answer, REPORT_PRICE_SATS)
      expect(paid.status).toBe(200)
      expect(paid.body.status).toBe('paid')
      remaining -= REPORT_PRICE_SATS + answer.feeSats
      expect((await h.call('/v1/budget', agent.key)).body.vault).toMatchObject({ status: 'open', satoshis: remaining })
    }
    expect(await spendableSats(merchantWallet)).toBe(merchantBefore + 3 * REPORT_PRICE_SATS)
    expect((await h.admin('/admin/audit?limit=1000')).body.anchors.filter((a: any) => a.source === 'payment')).toHaveLength(3)
    expect(logs.filter(l => /covenant payment ground in \d+ tr(y|ies)/.test(l))).toHaveLength(3)

    // The company takes the rest back with its key alone (the v1 reclaim branch).
    const before = await spendableSats(h.company)
    const r = await reclaimVault(h.company, h.url, ADMIN_TOKEN, agent.id)
    expect(r.satoshis).toBe(remaining)
    expect(await spendableSats(h.company)).toBeGreaterThan(before + remaining - 200)
    expect((await h.call('/v1/budget', agent.key)).body.vault.status).toBe('closed')
  })

  it('a price above the covenant cap is refused before anything is built, even if the rules later allow it', async () => {
    const agent = await h.createAgent('capped-bot', rules(REPORT_PRICE_SATS - 1), 10_000)
    await h.admin(`/admin/agents/${agent.id}/rules`, { method: 'PUT', body: rules(10_000) })
    const res = await h.pay(agent, report())
    // Denied by the proxy like any rule, with the reason; no transaction was built.
    expect(res.body).toMatchObject({ status: 'denied', reason: expect.stringMatching(/covenant caps a payment at 499 sats/) })
    expect(await h.db('vault_txs').where({ agent_id: agent.id, kind: 'payment' }).count({ n: '*' }).first()).toEqual({ n: 0 })
    await reclaimVault(h.company, h.url, ADMIN_TOKEN, agent.id)
  })

  it('the agent refuses to sign a price above the cap of a v2 vault', () => {
    const agentKey = PrivateKey.fromRandom()
    const pub = (): string => PrivateKey.fromRandom().toPublicKey().toString()
    const script = covenantLockingScript({ agentPub: agentKey.toPublicKey().toString(), policyPub: pub(), companyPub: pub(), maxSats: 1_000, maxFeeSats: 300 })
    const answer = (price: number): VaultSignAnswer => {
      const tx = new Transaction()
      tx.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: LockingScript.fromHex('') as any })
      const merchantScript = LockingScript.fromHex(`76a914${'11'.repeat(20)}88ac`)
      tx.addOutput({ satoshis: price, lockingScript: merchantScript })
      tx.addOutput({ satoshis: 10_000 - price - 300, lockingScript: script })
      return { status: 'sign', requestId: 'R-1', unsignedTx: tx.toHex(), sourceSatoshis: 10_000, sourceLockingScript: script.toHex(), merchantOutput: { satoshis: price, lockingScript: merchantScript.toHex() }, feeSats: 300 }
    }
    expect(signVaultPayment(answer(1_000), agentKey, 1_000)).toMatch(/^30/)
    expect(() => signVaultPayment(answer(1_001), agentKey, 1_001)).toThrow(/above the vault's covenant cap of 1000 sats/)
    // A fee above the covenant's MAX_FEE (here 301 of 300) would only fail on chain: refused before.
    const tooMuchFee = answer(1_000)
    const tx = Transaction.fromHex(tooMuchFee.unsignedTx)
    tx.outputs[1].satoshis! -= 1
    expect(() => signVaultPayment({ ...tooMuchFee, unsignedTx: tx.toHex(), feeSats: 301 }, agentKey, 1_000)).toThrow(/covenant fee cap of 300 sats/)
  })

  it('measures v2 against v1: script size, fee per payment', async () => {
    const pub = (): string => PrivateKey.fromRandom().toPublicKey().toString()
    const keys = { agentPub: pub(), policyPub: pub(), companyPub: pub() }
    const v1 = vaultLockingScript(keys)
    const v2 = covenantLockingScript({ ...keys, maxSats: CAP, maxFeeSats: 1_000 })
    const utxo = (script: LockingScript): any => ({ txid: 'ab'.repeat(32), vout: 0, satoshis: 30_000, lockingScript: script.toHex() })
    const merchantScript = LockingScript.fromHex(`76a914${'11'.repeat(20)}88ac`)
    const [p1, p2] = await Promise.all([buildVaultPayment(utxo(v1), 500, merchantScript, PLACEHOLDER_ANCHOR), buildVaultPayment(utxo(v2), 500, merchantScript, PLACEHOLDER_ANCHOR)])
    console.log(`vault v2: locking script ${v2.toBinary().length} bytes (v1 ${v1.toBinary().length}); fee per payment ${p2.feeSats} sats (v1 ${p1.feeSats}), +${p2.feeSats - p1.feeSats} sats at 100 sat/kB`)
    expect(p2.feeSats).toBeGreaterThan(p1.feeSats)
    expect(p2.feeSats).toBeLessThan(1_000) // the agent's default fee limit
  })
})
