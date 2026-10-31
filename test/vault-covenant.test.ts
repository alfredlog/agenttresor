/**
 * Vault v2 (OP_PUSH_TX covenant) on the SDK interpreter: the payment shapes it
 * accepts, every way it must fail, and that the company's reclaim works on it
 * in every one of those situations.
 */
import { describe, expect, it } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, Spend, Transaction, UnlockingScript, Utils, type Signature } from '@bsv/sdk'
import { anchorLockingScript } from '../src/audit/anchor-script'
import {
  covenantLockingScript, covenantSpendUnlockLength, covenantUnlockingScript, G_COMPRESSED, grindLockTime, isGroundS,
  outputsBlob, parseCovenantScript, parseVaultSource, pushTxS, scriptNum
} from '../src/vault/covenant'
import { checksigBytes, reclaimUnlockingScript, RECLAIM_UNLOCK_LENGTH, signVaultInput, vaultLockingScript, vaultPreimage } from '../src/vault/script'

const agent = PrivateKey.fromRandom()
const policy = PrivateKey.fromRandom()
const company = PrivateKey.fromRandom()
const stranger = PrivateKey.fromRandom()
const keys = { agentPub: agent.toPublicKey().toString(), policyPub: policy.toPublicKey().toString(), companyPub: company.toPublicKey().toString() }
const MAX = 5_000
const MAX_FEE = 1_000
const SOURCE = 50_000
const lockingScript = covenantLockingScript({ ...keys, maxSats: MAX, maxFeeSats: MAX_FEE })

const merchant = (): LockingScript => new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
const anchor = anchorLockingScript('cd'.repeat(32), 1234)
interface Out { satoshis: number, lockingScript: LockingScript }
const pay = (sats: number): Out => ({ satoshis: sats, lockingScript: merchant() })
const change = (sats: number, script = lockingScript): Out => ({ satoshis: sats, lockingScript: script })
const anchorOut = (sats = 0): Out => ({ satoshis: sats, lockingScript: anchor })

/** A transaction spending a vault of `source` sats (output 0 of a funding tx) into `outputs`, nLockTime ground. */
function spending (outputs: Out[], opts: { source?: number, script?: LockingScript, grind?: boolean } = {}): { tx: Transaction, tries: number } {
  const funding = new Transaction()
  funding.addOutput({ satoshis: opts.source ?? SOURCE, lockingScript: opts.script ?? lockingScript })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, sequence: 0xffffffff })
  for (const o of outputs) tx.addOutput(o)
  const tries = opts.grind === false ? 0 : grindLockTime(tx, 0, opts.source ?? SOURCE, opts.script ?? lockingScript)
  return { tx, tries }
}

const sign = (key: PrivateKey, tx: Transaction, source = SOURCE, script = lockingScript): Signature => signVaultInput(key, tx, 0, source, script)
const unlock = (tx: Transaction, source = SOURCE, script = lockingScript): UnlockingScript =>
  covenantUnlockingScript(sign(policy, tx, source, script), sign(agent, tx, source, script), tx, 0, source, script)
const reclaim = (tx: Transaction, source = SOURCE, script = lockingScript): UnlockingScript => reclaimUnlockingScript(sign(company, tx, source, script))

/** Runs the input on the interpreter (strict: low-S, minimal data, clean stack, push-only). */
function runs (tx: Transaction, unlockingScript: UnlockingScript, source = SOURCE, script = lockingScript): boolean {
  try {
    return new Spend({
      sourceTXID: tx.inputs[0].sourceTransaction!.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: source,
      lockingScript: script,
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

/** The unlocking script with chosen parts replaced. */
function unlockWith (tx: Transaction, parts: { policySig?: number[] | null, agentSig?: number[] | null, blob?: number[], preimage?: number[] }): UnlockingScript {
  const s = new UnlockingScript()
  const policySig = parts.policySig === undefined ? checksigBytes(sign(policy, tx)) : parts.policySig
  const agentSig = parts.agentSig === undefined ? checksigBytes(sign(agent, tx)) : parts.agentSig
  if (policySig !== null) s.writeBin(policySig)
  if (agentSig !== null) s.writeBin(agentSig)
  s.writeBin(parts.blob ?? outputsBlob(tx))
  s.writeBin(parts.preimage ?? vaultPreimage(tx, 0, SOURCE, lockingScript))
  s.writeOpCode(0x51)
  return s
}

// Every transaction a test builds, valid or not: the company must be able to reclaim from each.
const seen: Transaction[] = []
const track = (tx: Transaction): Transaction => { seen.push(tx); return tx }

describe('vault v2 script', () => {
  it('builds, parses back, and keeps the v1 reclaim branch exactly', () => {
    expect(parseCovenantScript(lockingScript)).toEqual({ ...keys, maxSats: MAX, maxFeeSats: MAX_FEE })
    expect(parseVaultSource(lockingScript)).toEqual({ ...keys, maxSats: MAX, maxFeeSats: MAX_FEE, version: 2 })
    expect(parseVaultSource(vaultLockingScript(keys))).toEqual({ ...keys, version: 1 })
    for (const max of [0, 1, 16, 17, 127, 128, 255, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(parseCovenantScript(covenantLockingScript({ ...keys, maxSats: max, maxFeeSats: MAX_FEE }))?.maxSats).toBe(max)
      expect(parseCovenantScript(covenantLockingScript({ ...keys, maxSats: MAX, maxFeeSats: max }))?.maxFeeSats).toBe(max)
    }
    // The script ends: OP_ELSE <companyPub> OP_CHECKSIG OP_ENDIF.
    expect(lockingScript.toHex().endsWith(`6721${keys.companyPub}ac68`)).toBe(true)
    expect(parseCovenantScript(vaultLockingScript(keys))).toBeUndefined()
    expect(lockingScript.toHex()).toContain(G_COMPRESSED)
  })

  it('script numbers are little-endian sign-magnitude, minimal', () => {
    expect(scriptNum(0n)).toEqual([])
    expect(scriptNum(127n)).toEqual([0x7f])
    expect(scriptNum(128n)).toEqual([0x80, 0x00])
    expect(scriptNum(253n)).toEqual([0xfd, 0x00])
    expect(scriptNum(-1n)).toEqual([0x81])
    expect(scriptNum(0x1234n)).toEqual([0x34, 0x12])
  })

  it('grinding gives the required s form, and the unlocking stays within the fee estimate', () => {
    const { tx } = spending([pay(1_000), change(SOURCE - 1_000 - 500), anchorOut()])
    expect(isGroundS(pushTxS(vaultPreimage(tx, 0, SOURCE, lockingScript)))).toBe(true)
    expect(unlock(tx).toBinary().length).toBeLessThanOrEqual(covenantSpendUnlockLength(tx, lockingScript.toBinary().length))
    expect(reclaim(tx).toBinary().length).toBeLessThanOrEqual(RECLAIM_UNLOCK_LENGTH)
  })
})

describe('vault v2: valid payments', () => {
  // Without change, the vault may hold at most price + MAX_FEE.
  it.each([
    ['with change', SOURCE, () => [pay(MAX), change(SOURCE - MAX - 600)]],
    ['without change', MAX + 600, () => [pay(MAX)]],
    ['with anchor', 1_000 + 600, () => [pay(1_000), anchorOut()]],
    ['with change and anchor', SOURCE, () => [pay(2_500), change(SOURCE - 2_500 - 600), anchorOut()]],
    ['paying 0 sats', SOURCE, () => [pay(0), change(SOURCE - 600)]],
    ['a fee of exactly MAX_FEE', SOURCE, () => [pay(1_000), change(SOURCE - 1_000 - MAX_FEE), anchorOut()]]
  ])('%s', (_name, source, outputs) => {
    const { tx } = spending(outputs(), { source })
    track(tx)
    expect(runs(tx, unlock(tx, source), source)).toBe(true)
  })
})

describe('vault v2: must fail', () => {
  it('output 0 above MAX_SATS', () => {
    const { tx } = spending([pay(MAX + 1), change(SOURCE - MAX - 601)])
    track(tx)
    expect(runs(tx, unlock(tx))).toBe(false)
    const alone = spending([pay(SOURCE - 600)]).tx
    track(alone)
    expect(runs(alone, unlock(alone))).toBe(false)
  })

  it('change to another script', () => {
    const thief = new P2PKH().lock(stranger.toPublicKey().toHash())
    const otherVault = covenantLockingScript({ ...keys, maxSats: MAX + 1, maxFeeSats: MAX_FEE }) // even a vault with another cap
    for (const script of [thief, otherVault, vaultLockingScript(keys)]) {
      const { tx } = spending([pay(1_000), change(SOURCE - 1_600, script)])
      track(tx)
      expect(runs(tx, unlock(tx))).toBe(false)
      const anchored = spending([pay(1_000), change(SOURCE - 1_600, script), anchorOut()]).tx
      track(anchored)
      expect(runs(anchored, unlock(anchored))).toBe(false)
    }
  })

  it('an extra output that is not the anchor, anywhere', () => {
    const extra = (): Out => ({ satoshis: 100, lockingScript: new P2PKH().lock(stranger.toPublicKey().toHash()) })
    const zeroExtra = (): Out => ({ satoshis: 0, lockingScript: LockingScript.fromHex('006a0474657374') }) // a foreign OP_RETURN
    for (const outputs of [
      [pay(1_000), extra()],
      [pay(1_000), change(SOURCE - 1_700), extra()],
      [pay(1_000), change(SOURCE - 1_700), anchorOut(), extra()],
      [pay(1_000), extra(), change(SOURCE - 1_700)],
      [pay(1_000), anchorOut(), change(SOURCE - 1_600)],
      [pay(1_000), anchorOut(), anchorOut()],
      [pay(1_000), change(SOURCE - 1_600), change(0)],
      [pay(1_000), zeroExtra()],
      [pay(1_000), change(SOURCE - 1_600), zeroExtra()]
    ]) {
      const { tx } = spending(outputs)
      track(tx)
      expect(runs(tx, unlock(tx))).toBe(false)
    }
  })

  it('an anchor holding satoshis', () => {
    for (const [source, outputs] of [[1_601, [pay(1_000), anchorOut(1)]], [SOURCE, [pay(1_000), change(SOURCE - 1_601), anchorOut(1)]]] as const) {
      const { tx } = spending([...outputs], { source })
      track(tx)
      expect(runs(tx, unlock(tx, source), source)).toBe(false)
    }
  })

  it('a fee above MAX_FEE: the rest of the vault cannot go to the miners', () => {
    for (const [source, outputs] of [
      [SOURCE, [pay(1_000)]], // no change: 49,000 sats of fee
      [SOURCE, [pay(MAX), anchorOut()]],
      [1_000 + MAX_FEE + 1, [pay(1_000)]], // one satoshi over
      [SOURCE, [pay(1_000), change(SOURCE - 1_000 - MAX_FEE - 1)]],
      [SOURCE, [pay(1_000), change(SOURCE - 1_000 - MAX_FEE - 1), anchorOut()]],
      [SOURCE, [pay(0), change(1)]]
    ] as const) {
      const { tx } = spending([...outputs], { source })
      track(tx)
      expect(runs(tx, unlock(tx, source), source)).toBe(false)
    }
  })

  it('any single byte of the preimage changed', () => {
    const { tx } = spending([pay(1_000), change(SOURCE - 1_600), anchorOut()])
    track(tx)
    const preimage = vaultPreimage(tx, 0, SOURCE, lockingScript)
    expect(runs(tx, unlockWith(tx, { preimage }))).toBe(true)
    for (let i = 0; i < preimage.length; i++) {
      const changed = preimage.slice()
      changed[i] ^= 0x01
      expect(runs(tx, unlockWith(tx, { preimage: changed })), `byte ${i} of ${preimage.length}`).toBe(false)
    }
  })

  it('an outputsBlob that does not match hashOutputs', () => {
    const { tx } = spending([pay(1_000), change(SOURCE - 1_600)])
    track(tx)
    const blob = outputsBlob(tx)
    const lower = blob.slice()
    lower[0] ^= 0x01 // output 0's value, as the covenant would read it
    expect(runs(tx, unlockWith(tx, { blob: lower }))).toBe(false)
    expect(runs(tx, unlockWith(tx, { blob: blob.slice(0, 8 + 1 + 25) }))).toBe(false) // output 0 alone, hiding the rest
    expect(runs(tx, unlockWith(tx, { blob: [...blob, 0] }))).toBe(false)
  })

  it('a preimage (and outputs) of another transaction', () => {
    const { tx } = spending([pay(MAX + 1_000)]) // what really happens: too much to output 0
    track(tx)
    const decoy = spending([pay(1_000), change(SOURCE - 1_600)]).tx // a valid-looking payment from the same vault
    const decoyPreimage = vaultPreimage(decoy, 0, SOURCE, lockingScript)
    expect(runs(tx, unlockWith(tx, { preimage: decoyPreimage, blob: outputsBlob(decoy) }))).toBe(false)
    // Even with the decoy's own signatures.
    expect(runs(tx, unlockWith(tx, {
      policySig: checksigBytes(sign(policy, decoy)), agentSig: checksigBytes(sign(agent, decoy)), preimage: decoyPreimage, blob: outputsBlob(decoy)
    }))).toBe(false)
  })

  it('a missing or wrong agent or policy signature', () => {
    const { tx } = spending([pay(1_000), change(SOURCE - 1_600)])
    track(tx)
    const strangerSig = checksigBytes(sign(stranger, tx))
    expect(runs(tx, unlockWith(tx, { agentSig: null }))).toBe(false)
    expect(runs(tx, unlockWith(tx, { policySig: null }))).toBe(false)
    expect(runs(tx, unlockWith(tx, { agentSig: strangerSig }))).toBe(false)
    expect(runs(tx, unlockWith(tx, { policySig: strangerSig }))).toBe(false)
    expect(runs(tx, unlockWith(tx, { agentSig: checksigBytes(sign(policy, tx)) }))).toBe(false) // policy signs twice
    expect(runs(tx, unlockWith(tx, { policySig: [], agentSig: [] }))).toBe(false)
  })

  it('a transaction that was not ground (s in the wrong form) fails instead of misreading the signature', () => {
    for (let lockTime = 0; lockTime < 40; lockTime++) {
      const { tx } = spending([pay(1_000), change(SOURCE - 1_600)], { grind: false })
      tx.lockTime = lockTime
      if (isGroundS(pushTxS(vaultPreimage(tx, 0, SOURCE, lockingScript)))) continue
      track(tx)
      expect(runs(tx, unlock(tx))).toBe(false)
      return
    }
    throw new Error('no unground lock time found')
  })
})

describe('vault v2: the company reclaims alone, in every situation above', () => {
  it('reclaims from every transaction the tests built, valid or not', () => {
    expect(seen.length).toBeGreaterThan(20)
    for (const tx of seen) {
      expect(runs(tx, reclaim(tx))).toBe(true)
      // Nobody else can use the reclaim branch.
      expect(runs(tx, reclaimUnlockingScript(sign(stranger, tx)))).toBe(false)
      expect(runs(tx, reclaimUnlockingScript(sign(agent, tx)))).toBe(false)
      expect(runs(tx, reclaimUnlockingScript(sign(policy, tx)))).toBe(false)
    }
  })

  it('reclaims whatever the transaction looks like: no outputs to us, everything to fee, huge outputs', () => {
    const shapes: Out[][] = [
      [],
      [{ satoshis: SOURCE - 200, lockingScript: new P2PKH().lock(company.toPublicKey().toHash()) }],
      [pay(SOURCE)],
      [{ satoshis: 0, lockingScript: LockingScript.fromHex(`006a4d0010${'00'.repeat(4096)}`) }]
    ]
    for (const outputs of shapes) {
      const { tx } = spending(outputs, { grind: false })
      tx.lockTime = 123_456 // not ground: reclaim does not care
      expect(runs(tx, reclaim(tx))).toBe(true)
    }
  })
})

describe('vault v2: 500 random valid payments', () => {
  it('all verify', () => {
    let totalTries = 0
    let seed = 0x5eed
    const rand = (n: number): number => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed % n }
    for (let i = 0; i < 500; i++) {
      const max = 1 + rand(100_000)
      const maxFee = 300 + rand(2_000)
      const script = covenantLockingScript({ ...keys, maxSats: max, maxFeeSats: maxFee })
      const price = rand(max + 1)
      const fee = rand(maxFee + 1)
      const withChange = rand(4) !== 0
      // Without change the vault holds exactly price + fee; with change, anything more.
      const source = withChange ? price + fee + 1 + rand(1_000_000) : price + fee
      const outputs: Out[] = [pay(price)]
      if (withChange) outputs.push(change(source - price - fee, script))
      if (rand(2) === 0) outputs.push({ satoshis: 0, lockingScript: anchorLockingScript(Utils.toHex(Array.from({ length: 32 }, () => rand(256))), 1 + rand(10_000_000)) })
      const { tx, tries } = spending(outputs, { source, script })
      totalTries += tries
      expect(runs(tx, unlock(tx, source, script), source, script), `payment ${i}`).toBe(true)
    }
    const avg = totalTries / 500
    console.log(`vault v2: average nLockTime grinding tries over 500 payments: ${avg.toFixed(2)}`)
    expect(avg).toBeLessThan(4)
  })
})
