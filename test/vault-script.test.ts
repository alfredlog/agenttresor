/** The vault script on the SDK interpreter: both paths, and every way it must fail. */
import { describe, expect, it } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, Spend, Transaction, UnlockingScript, type Signature } from '@bsv/sdk'
import {
  parseVaultScript, RECLAIM_UNLOCK_LENGTH, reclaimUnlockingScript, signVaultInput, SPEND_UNLOCK_LENGTH,
  spendUnlockingScript, vaultLockingScript, checksigBytes, verifyVaultSignature
} from '../src/vault/script'

const agent = PrivateKey.fromRandom()
const policy = PrivateKey.fromRandom()
const company = PrivateKey.fromRandom()
const stranger = PrivateKey.fromRandom()
const keys = { agentPub: agent.toPublicKey().toString(), policyPub: policy.toPublicKey().toString(), companyPub: company.toPublicKey().toString() }
const lockingScript = vaultLockingScript(keys)
const SOURCE_SATS = 10_000

/** A funding tx with the vault at output 0, and a tx spending it. */
function spendingTx (): Transaction {
  const funding = new Transaction()
  funding.addOutput({ satoshis: SOURCE_SATS, lockingScript })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput({ satoshis: 9_000, lockingScript: new P2PKH().lock(stranger.toAddress()) })
  return tx
}

const sign = (key: PrivateKey, tx: Transaction): Signature => signVaultInput(key, tx, 0, SOURCE_SATS, lockingScript)

function runs (tx: Transaction, unlockingScript: UnlockingScript): boolean {
  const input = tx.inputs[0]
  try {
    return new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: SOURCE_SATS,
      lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      unlockingScript,
      inputSequence: 0xffffffff,
      inputIndex: 0,
      lockTime: tx.lockTime
    }).validate()
  } catch {
    return false
  }
}

const raw = (...chunks: Array<number[] | number>): UnlockingScript =>
  new UnlockingScript(chunks.map(c => typeof c === 'number' ? { op: c } : { op: c.length, data: c }))

describe('vault script', () => {
  it('spend path: agent AND policy signatures unlock it', () => {
    const tx = spendingTx()
    const unlock = spendUnlockingScript(sign(policy, tx), sign(agent, tx))
    expect(unlock.toBinary().length).toBeLessThanOrEqual(SPEND_UNLOCK_LENGTH)
    expect(runs(tx, unlock)).toBe(true)
  })

  it('reclaim path: the company signature alone unlocks it', () => {
    const tx = spendingTx()
    const unlock = reclaimUnlockingScript(sign(company, tx))
    expect(unlock.toBinary().length).toBeLessThanOrEqual(RECLAIM_UNLOCK_LENGTH)
    expect(runs(tx, unlock)).toBe(true)
  })

  it('the policy key alone (the proxy) cannot spend', () => {
    const tx = spendingTx()
    const p = checksigBytes(sign(policy, tx))
    expect(runs(tx, raw(p, 0x51))).toBe(false) // only the policy signature
    expect(runs(tx, raw(p, p, 0x51))).toBe(false) // policy signature in the agent's place too
    expect(runs(tx, raw(p, 0x00))).toBe(false) // policy signature on the reclaim path
  })

  it('the agent key alone cannot spend', () => {
    const tx = spendingTx()
    const a = checksigBytes(sign(agent, tx))
    expect(runs(tx, raw(a, 0x51))).toBe(false)
    expect(runs(tx, raw(a, a, 0x51))).toBe(false)
    expect(runs(tx, raw(a, 0x00))).toBe(false)
  })

  it('refuses wrong keys and swapped signatures', () => {
    const tx = spendingTx()
    expect(runs(tx, spendUnlockingScript(sign(stranger, tx), sign(agent, tx)))).toBe(false)
    expect(runs(tx, spendUnlockingScript(sign(policy, tx), sign(stranger, tx)))).toBe(false)
    expect(runs(tx, spendUnlockingScript(sign(agent, tx), sign(policy, tx)))).toBe(false) // order matters
    expect(runs(tx, reclaimUnlockingScript(sign(stranger, tx)))).toBe(false)
    expect(runs(tx, reclaimUnlockingScript(sign(policy, tx)))).toBe(false)
  })

  it('a signature for one transaction does not unlock another', () => {
    const tx = spendingTx()
    const other = spendingTx()
    other.outputs[0].satoshis = 9_500
    expect(runs(other, spendUnlockingScript(sign(policy, tx), sign(agent, tx)))).toBe(false)
    expect(verifyVaultSignature(keys.agentPub, sign(agent, tx), other, 0, SOURCE_SATS, lockingScript)).toBe(false)
    expect(verifyVaultSignature(keys.agentPub, sign(agent, tx), tx, 0, SOURCE_SATS, lockingScript)).toBe(true)
  })

  it('parses its own script back and rejects anything else', () => {
    expect(parseVaultScript(lockingScript)).toEqual(keys)
    expect(parseVaultScript(lockingScript.toHex())).toEqual(keys)
    expect(parseVaultScript(new P2PKH().lock(agent.toAddress()))).toBeUndefined()
    expect(parseVaultScript(LockingScript.fromHex(lockingScript.toHex() + '51'))).toBeUndefined()
  })
})
