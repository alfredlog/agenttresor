/**
 * The non-custodial vault, end to end on the mock chain. The company funds a
 * vault from its own wallet; every payment goes from the vault straight to the
 * merchant and needs the agent's signature AND the proxy's policy signature;
 * the company can reclaim alone; the proxy alone can move nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { signVaultPayment, type VaultSignAnswer } from '../src/agent/vault-signer'
import { fundVault, reclaimVault } from '../src/company/vault-client'
import { createMerchantApp, REPORT_PRICE_SATS, ROOM_RATES_SATS } from '../src/merchant/app'
import { PolicyKeys } from '../src/vault/keys'
import { vaultLockingScript, signVaultInput, checksigBytes, SPEND_UNLOCK_LENGTH } from '../src/vault/script'
import { VAULT_PROTOCOL, vaultKeyId } from '../src/vault/protocol'
import { ADMIN_TOKEN, createProxyHarness, spendableSats, type ProxyHarness, type TestAgent } from './helpers/proxy'

let h: ProxyHarness
let merchantWallet: Wallet
let merchant: string, merchantHost: string
const report = (purpose = 'Market report'): object => ({ url: `${merchant}/api/report`, purpose })
const rules = (extra: object = {}): object => ({ allowedHosts: [merchantHost], maxPerPaymentSats: 20_000, dailyBudgetSats: 100_000, approvalThresholdSats: 1_000, ...extra })
const budget = async (a: TestAgent): Promise<any> => (await h.call('/v1/budget', a.key)).body
const vaultTxCount = async (): Promise<number> => Number((await h.db('vault_txs').count({ n: '*' }).first())?.n)
const broadcastCount = async (): Promise<number> => Number((await h.db('vault_txs').where({ status: 'broadcast' }).count({ n: '*' }).first())?.n)

beforeAll(async () => {
  h = await createProxyHarness()
  merchantWallet = await h.chain.makeWallet()
  merchant = await h.listen(createMerchantApp(merchantWallet))
  merchantHost = new URL(merchant).host
})
afterAll(async () => { await h?.close() })

describe('funding', () => {
  it('the company funds a vault from its wallet; the proxy verifies and opens it', async () => {
    const agent = await h.createAgent('funded-bot', rules())
    const before = await spendableSats(h.company)
    const funded = await fundVault(h.company, h.url, ADMIN_TOKEN, agent.id, 50_000)
    expect(funded.txid).toMatch(/^[0-9a-f]{64}$/)
    expect((await budget(agent)).vault).toEqual({ status: 'open', satoshis: 50_000, outpoint: `${funded.txid}.${funded.vout}` })
    expect(await spendableSats(h.company)).toBeLessThan(before - 50_000)
    const listed = (await h.admin('/admin/vaults')).body.vaults.find((v: any) => v.agentId === agent.id)
    expect(listed).toMatchObject({ status: 'open', satoshis: 50_000, explorerUrl: `https://test.whatsonchain.com/tx/${funded.txid}` })
  })

  it('refuses a funding output that is not the agent\'s vault script', async () => {
    const agent = await h.createAgent('wrong-script-bot', rules())
    const params = (await h.admin(`/admin/vaults/${agent.id}/params`)).body
    const { publicKey: companyPub } = await h.company.getPublicKey({ protocolID: VAULT_PROTOCOL, keyID: vaultKeyId(agent.id), counterparty: 'self' })
    // Same agent and policy keys, but a company key the company does not hold.
    const stranger = PrivateKey.fromRandom().toPublicKey().toString()
    const lockingScript = vaultLockingScript({ agentPub: params.agentPub, policyPub: params.policyPub, companyPub: stranger }).toHex()
    const created = await h.company.createAction({
      description: 'Fund a wrong vault',
      outputs: [{ lockingScript, satoshis: 1_000, outputDescription: 'not the vault' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const vout = Transaction.fromAtomicBEEF(created.tx!).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
    const res = await h.admin(`/admin/vaults/${agent.id}/funded`, { method: 'POST', body: { beef: Utils.toHex(created.tx!), vout, companyPub } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not this agent's vault script/)
    expect((await budget(agent)).vault.status).toBe('awaiting_funding')
  })

  it('cannot fund before the agent registered its key', async () => {
    const created = await h.admin('/admin/agents', { method: 'POST', body: { name: 'no-key-bot' } })
    expect((await h.admin(`/admin/vaults/${created.body.id}/params`)).status).toBe(409)
  })
})

describe('paying from the vault', () => {
  it('pays the merchant from the vault three times in a row, each spending the previous change', async () => {
    const agent = await h.createAgent('chain-bot', rules(), 20_000)
    let vault = (await budget(agent)).vault
    for (let i = 1; i <= 3; i++) {
      const merchantBefore = await spendableSats(merchantWallet)
      const res = await h.pay(agent, report(`Report ${i}`))
      expect(res.status).toBe(200)
      const answer = res.body as VaultSignAnswer
      expect(answer).toMatchObject({ status: 'sign', sourceSatoshis: vault.satoshis, merchantOutput: { satoshis: REPORT_PRICE_SATS } })
      const tx = Transaction.fromHex(answer.unsignedTx)
      expect(`${tx.inputs[0].sourceTXID!}.${tx.inputs[0].sourceOutputIndex}`).toBe(vault.outpoint) // spends the current vault UTXO
      expect(answer.feeSats).toBeGreaterThan(0)

      const paid = await h.sign(agent, answer, REPORT_PRICE_SATS)
      expect(paid.status).toBe(200)
      // The txid only exists once both signatures are in the unlocking script.
      const txid = paid.body.txid as string
      expect(paid.body).toMatchObject({ status: 'paid', satoshis: REPORT_PRICE_SATS, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
      expect(paid.body.response.body.receipt).toEqual({ txid, satoshisPaid: REPORT_PRICE_SATS })
      expect(await spendableSats(merchantWallet)).toBe(merchantBefore + REPORT_PRICE_SATS)
      const onChain = Transaction.fromBinary((await h.chain.services.getRawTx(txid)).rawTx!)
      expect(onChain.outputs.map(o => o.satoshis)).toEqual(tx.outputs.map(o => o.satoshis))

      const after = (await budget(agent)).vault
      expect(after).toEqual({ status: 'open', satoshis: vault.satoshis - REPORT_PRICE_SATS - answer.feeSats, outpoint: `${txid}.1` })
      vault = after
    }
    // Fees come out of the vault but not out of the daily budget.
    expect((await budget(agent)).spentTodaySats).toBe(3 * REPORT_PRICE_SATS)
  })

  it('rules deny: nothing is built and the vault is untouched', async () => {
    const agent = await h.createAgent('denied-bot', rules(), 10_000)
    const [vaultBefore, txsBefore] = [(await budget(agent)).vault, await vaultTxCount()]
    const res = await h.pay(agent, { url: `${merchant.replace('localhost', '127.0.0.1')}/api/report`, purpose: 'Other host' })
    expect(res.status).toBe(403)
    const over = await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'suite', nights: 5 }, purpose: 'Too expensive' })
    expect(over.status).toBe(403)
    expect(await vaultTxCount()).toBe(txsBefore)
    expect((await budget(agent)).vault).toEqual(vaultBefore)
  })

  it('approval flow: pending, approve, execute, sign, paid', async () => {
    const agent = await h.createAgent('approval-bot', rules(), 10_000)
    const res = await h.pay(agent, { url: `${merchant}/api/hotel/book`, method: 'POST', body: { roomType: 'standard', nights: 1 }, purpose: 'Hotel' })
    expect(res.status).toBe(202)
    const id = res.body.requestId
    expect((await h.admin(`/admin/requests/${id}/approve`, { method: 'POST' })).status).toBe(200)
    const exec = await h.call(`/v1/requests/${id}/execute`, agent.key, { method: 'POST' })
    expect(exec.status).toBe(200)
    expect(exec.body).toMatchObject({ status: 'sign', requestId: id, merchantOutput: { satoshis: ROOM_RATES_SATS.standard } })
    const paid = await h.sign(agent, exec.body, ROOM_RATES_SATS.standard)
    expect(paid.status).toBe(200)
    expect(paid.body.response.body.order).toMatchObject({ roomType: 'standard', nights: 1 })
    expect((await h.call(`/v1/requests/${id}`, agent.key)).body.status).toBe('paid')
  })
})

describe('what the vault refuses', () => {
  let agent: TestAgent
  beforeAll(async () => { agent = await h.createAgent('guarded-bot', rules(), 10_000) })

  it('the vault signer refuses a tampered transaction', async () => {
    const answer = (await h.pay(agent, report())).body as VaultSignAnswer
    const tamper = (edit: (tx: Transaction) => void, a: Partial<VaultSignAnswer> = {}): VaultSignAnswer => {
      const tx = Transaction.fromHex(answer.unsignedTx)
      edit(tx)
      return { ...answer, ...a, unsignedTx: tx.toHex() }
    }
    // Output 0 raised: more than the agent asked to pay.
    expect(() => signVaultPayment(tamper(tx => { tx.outputs[0].satoshis = 900 }), agent.signer, REPORT_PRICE_SATS)).toThrow(/output 0 pays 900/)
    // Even if the proxy also lies about the price in the answer.
    expect(() => signVaultPayment(tamper(tx => { tx.outputs[0].satoshis = 900 }, { merchantOutput: { ...answer.merchantOutput, satoshis: 900 } }), agent.signer, REPORT_PRICE_SATS)).toThrow(/refusing/)
    // Change sent elsewhere.
    const thief = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    expect(() => signVaultPayment(tamper(tx => { tx.outputs[1].lockingScript = thief }), agent.signer, REPORT_PRICE_SATS)).toThrow(/change to the vault/)
    // Change reduced: the difference would go to the miners.
    expect(() => signVaultPayment(tamper(tx => { tx.outputs[1].satoshis! -= 5_000 }), agent.signer, REPORT_PRICE_SATS)).toThrow(/fee/)
    // An extra output.
    expect(() => signVaultPayment(tamper(tx => { tx.addOutput({ satoshis: 1, lockingScript: thief }) }), agent.signer, REPORT_PRICE_SATS)).toThrow(/2 outputs/)
    // Another agent's vault.
    expect(() => signVaultPayment(answer, PrivateKey.fromRandom(), REPORT_PRICE_SATS)).toThrow(/does not belong/)
    // The genuine answer is fine.
    expect((await h.sign(agent, answer, REPORT_PRICE_SATS)).status).toBe(200)
  })

  it('a bad agent signature gets 400 and nothing is broadcast', async () => {
    const vaultBefore = (await budget(agent)).vault
    const broadcastsBefore = await broadcastCount()
    const answer = (await h.pay(agent, report())).body as VaultSignAnswer
    const tx = Transaction.fromHex(answer.unsignedTx)
    const wrong = signVaultInput(PrivateKey.fromRandom(), tx, 0, answer.sourceSatoshis, LockingScript.fromHex(answer.sourceLockingScript)).toDER('hex')
    const res = await h.call(`/v1/requests/${answer.requestId}/sign`, agent.key, { method: 'POST', body: { signature: wrong } })
    expect(res.status).toBe(400)
    expect((await h.call(`/v1/requests/${answer.requestId}/sign`, agent.key, { method: 'POST', body: { signature: 'zz' } })).status).toBe(400)
    expect(await broadcastCount()).toBe(broadcastsBefore)
    expect((await budget(agent)).vault).toEqual(vaultBefore)
    // The right signature still works inside the window.
    expect((await h.sign(agent, answer, REPORT_PRICE_SATS)).status).toBe(200)
  })

  it('a signature more than 20 s late gets 409 and the vault is unchanged; execute builds it again', async () => {
    const answer = (await h.pay(agent, report())).body as VaultSignAnswer
    const vaultBefore = (await budget(agent)).vault
    h.clock.offset = 21_000
    try {
      const late = await h.sign(agent, answer, REPORT_PRICE_SATS)
      expect(late.status).toBe(409)
      expect(late.body.error).toMatch(/too late|more than 20 s/)
    } finally {
      h.clock.offset = 0
    }
    expect((await budget(agent)).vault).toEqual(vaultBefore)
    const again = await h.call(`/v1/requests/${answer.requestId}/execute`, agent.key, { method: 'POST' })
    expect(again.body.status).toBe('sign')
    expect((await h.sign(agent, again.body, REPORT_PRICE_SATS)).status).toBe(200)
  })

  it('a second pay while one waits for a signature gets 409', async () => {
    const first = (await h.pay(agent, report('First'))).body as VaultSignAnswer
    const second = await h.pay(agent, report('Second'))
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/waiting for a signature/)
    expect((await h.sign(agent, first, REPORT_PRICE_SATS)).status).toBe(200)
    expect((await h.pay(agent, report('Third'))).body.status).toBe('sign') // free again
  })

  it('refuses when price + fee is above the vault balance (403)', async () => {
    const small = await h.createAgent('small-vault-bot', rules(), 1_000)
    expect((await h.payAndSign(small, report('Fits'), REPORT_PRICE_SATS)).status).toBe(200)
    const res = await h.pay(small, report('Does not fit'))
    expect(res.status).toBe(403)
    expect(res.body.reason).toMatch(/vault balance too low/)
  })
})

describe('reclaim', () => {
  it('the proxy alone cannot spend the vault, the company alone can reclaim it', async () => {
    const agent = await h.createAgent('reclaim-bot', rules(), 30_000)
    const utxo = (await h.admin(`/admin/vaults/${agent.id}/utxo`)).body

    // The proxy tries on its own: policy signature only, to an address of its choice.
    const beef = Beef.fromString(utxo.beef, 'hex')
    const [txid, vout] = utxo.outpoint.split('.')
    const theft = new Transaction()
    theft.addInput({ sourceTransaction: beef.findAtomicTransaction(txid), sourceOutputIndex: Number(vout), sequence: 0xffffffff })
    theft.addOutput({ satoshis: utxo.satoshis - 100, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    const policySig = signVaultInput(new PolicyKeys(h.policyRootKey).policyKey(agent.id), theft, 0, utxo.satoshis, LockingScript.fromHex(utxo.lockingScript))
    const p = checksigBytes(policySig)
    theft.inputs[0].unlockingScript = UnlockingScript.fromASM(`${Utils.toHex(p)} ${Utils.toHex(p)} OP_1`)
    expect(theft.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(SPEND_UNLOCK_LENGTH)
    beef.mergeTransaction(theft)
    await expect(h.chain.broadcaster.broadcast(beef.toBinaryAtomic(theft.id('hex')), theft.id('hex'))).rejects.toThrow(/refused/)

    // The company reclaims with its wallet alone.
    const before = await spendableSats(h.company)
    const reclaimed = await reclaimVault(h.company, h.url, ADMIN_TOKEN, agent.id)
    expect(reclaimed.satoshis).toBe(30_000)
    const after = await spendableSats(h.company)
    expect(after).toBeGreaterThan(before + 29_000) // the vault minus a small fee
    expect((await budget(agent)).vault).toEqual({ status: 'closed', satoshis: 0, outpoint: null })

    // A closed vault pays nothing.
    const res = await h.pay(agent, report())
    expect(res.status).toBe(403)
    expect(res.body.reason).toMatch(/no funded vault/)
  })
})
