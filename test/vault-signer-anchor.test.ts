/**
 * The agent's vault signer and the audit anchor a payment may carry (option A).
 * Pure unit tests: the unsigned transactions are built by hand, no chain.
 * Allowed: [merchant, change] / [merchant] as before, plus exactly one 0-sat
 * AgentTresor anchor as the last output. Anything else is refused.
 */
import { describe, expect, it } from 'vitest'
import { LockingScript, OP, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { signVaultPayment, type VaultSignAnswer } from '../src/agent/vault-signer'
import { anchorLockingScript } from '../src/audit/anchor-script'
import { vaultLockingScript } from '../src/vault/script'

const PRICE = 2_000
const FEE = 30

const agentKey = PrivateKey.fromRandom()
const vaultScript = vaultLockingScript({
  agentPub: agentKey.toPublicKey().toString(),
  policyPub: PrivateKey.fromRandom().toPublicKey().toString(),
  companyPub: PrivateKey.fromRandom().toPublicKey().toString()
})
const merchantScript = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
const anchor = anchorLockingScript('ab'.repeat(32), 42)
const thief = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
/** OP_FALSE OP_RETURN "other-app" <32 bytes> "42": the anchor's shape with someone else's prefix. */
const foreignOpReturn = new LockingScript()
  .writeOpCode(OP.OP_FALSE)
  .writeOpCode(OP.OP_RETURN)
  .writeBin(Utils.toArray('other-app', 'utf8'))
  .writeBin(Utils.toArray('ab'.repeat(32), 'hex'))
  .writeBin(Utils.toArray('42', 'utf8')) as LockingScript

interface Out { satoshis: number, lockingScript: LockingScript }

/** A 'sign' answer spending a vault UTXO of `sourceSatoshis` into exactly these outputs, announced honestly. */
function answer (sourceSatoshis: number, outputs: Out[], announcedPrice = PRICE): VaultSignAnswer {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: 'cd'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
  for (const o of outputs) tx.addOutput(o)
  return {
    status: 'sign',
    requestId: 'R-0000000000',
    unsignedTx: tx.toHex(),
    sourceSatoshis,
    sourceLockingScript: vaultScript.toHex(),
    merchantOutput: { satoshis: announcedPrice, lockingScript: merchantScript.toHex() },
    feeSats: sourceSatoshis - outputs.reduce((s, o) => s + o.satoshis, 0)
  }
}

const pay = (sats = PRICE): Out => ({ satoshis: sats, lockingScript: merchantScript })
const change = (sats: number, lockingScript = vaultScript): Out => ({ satoshis: sats, lockingScript })
const anchorOut = (sats = 0): Out => ({ satoshis: sats, lockingScript: anchor })

// Agent vault: 10,000 sats in, price + fee out, the rest back to the vault.
const VAULT_SATS = 10_000
const CHANGE = VAULT_SATS - PRICE - FEE
// Request vault: funded with exactly price + fee.
const REQUEST_SATS = PRICE + FEE

const sign = (a: VaultSignAnswer): string => signVaultPayment(a, agentKey, PRICE)

describe('vault signer and the audit anchor: refuses', () => {
  it('an anchor output holding 1 sat', () => {
    expect(() => sign(answer(VAULT_SATS, [pay(), change(CHANGE - 1), anchorOut(1)]))).toThrow(/anchor output must hold 0 sats/)
    expect(() => sign(answer(REQUEST_SATS, [pay(), anchorOut(1)]))).toThrow(/anchor output must hold 0 sats/)
  })

  it('an anchor that is not last (anchor, then change)', () => {
    expect(() => sign(answer(VAULT_SATS, [pay(), anchorOut(), change(CHANGE)]))).toThrow(/expected 1 or 2 outputs besides an audit anchor, got 3/)
  })

  it('two anchor outputs', () => {
    expect(() => sign(answer(VAULT_SATS, [pay(), change(CHANGE), anchorOut(), anchorOut()]))).toThrow(/expected 1 or 2 outputs besides an audit anchor, got 3/)
    expect(() => sign(answer(REQUEST_SATS, [pay(), anchorOut(), anchorOut()]))).toThrow(/output 1 does not return the change to the vault/)
  })

  it('a foreign OP_RETURN (not the agenttresor-audit prefix) as the last output', () => {
    expect(() => sign(answer(VAULT_SATS, [pay(), change(CHANGE), { satoshis: 0, lockingScript: foreignOpReturn }]))).toThrow(/expected 1 or 2 outputs/)
    expect(() => sign(answer(REQUEST_SATS, [pay(), { satoshis: 0, lockingScript: foreignOpReturn }]))).toThrow(/output 1 does not return the change to the vault/)
  })

  it('an agent vault payment with an anchor but the change sent to another script', () => {
    expect(() => sign(answer(VAULT_SATS, [pay(), change(CHANGE, thief), anchorOut()]))).toThrow(/output 1 does not return the change to the vault/)
  })

  it('a request-vault payment (1 output) plus anchor with a wrong price', () => {
    expect(() => sign(answer(REQUEST_SATS, [pay(PRICE + 10), anchorOut()], PRICE + 10))).toThrow(/output 0 pays 2010 sats, expected 2000/)
  })
})

describe('vault signer and the audit anchor: signs', () => {
  const DER = /^30[0-9a-f]+$/

  it('an agent vault payment [merchant, change, anchor]', () => {
    expect(sign(answer(VAULT_SATS, [pay(), change(CHANGE), anchorOut()]))).toMatch(DER)
  })

  it('a request-vault payment [merchant, anchor]', () => {
    expect(sign(answer(REQUEST_SATS, [pay(), anchorOut()]))).toMatch(DER)
  })

  it('both forms without an anchor, as before', () => {
    expect(sign(answer(VAULT_SATS, [pay(), change(CHANGE)]))).toMatch(DER)
    expect(sign(answer(REQUEST_SATS, [pay()]))).toMatch(DER)
  })

  it('the anchor does not change what is signed for: the fee is the same with or without it', () => {
    expect(answer(VAULT_SATS, [pay(), change(CHANGE), anchorOut()]).feeSats).toBe(FEE)
    expect(answer(REQUEST_SATS, [pay(), anchorOut()]).feeSats).toBe(FEE)
  })
})
