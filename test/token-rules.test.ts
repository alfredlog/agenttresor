import { describe, expect, it } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { buildBsv21Script, decodeBsv21, MAX_U64 } from '../src/token/inscription'
import { identifyAdmissible, UnknownTokenInputError } from '../src/token/rules'
import { ownReceivePublicKey, receivePublicKey } from '../src/token/addresses'

const A = 'ab'.repeat(20)
const B = 'cd'.repeat(20)
const EMPTY = new UnlockingScript([])

function deployTx (amt = '1000'): { tx: Transaction, tokenId: string } {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: buildBsv21Script({ op: 'deploy+mint', amt, sym: 'KIT', dec: '0' }, A), satoshis: 1 })
  return { tx, tokenId: `${tx.id('hex')}_0` }
}

function spend (parent: Transaction, vout: number, outputs: Array<{ id: string, amt: string, owner?: string, op?: 'transfer' | 'burn' }>): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: vout, unlockingScript: EMPTY })
  for (const o of outputs) {
    tx.addOutput({ lockingScript: buildBsv21Script({ op: o.op ?? 'transfer', id: o.id, amt: o.amt }, o.owner ?? B), satoshis: 1 })
  }
  return tx
}

describe('inscription', () => {
  it('round-trips a canonical transfer', () => {
    const s = buildBsv21Script({ op: 'transfer', id: `${'aa'.repeat(32)}_0`, amt: '42' }, A)
    expect(decodeBsv21(s)).toMatchObject({ op: 'transfer', amt: '42', amount: 42n, ownerPkh: A })
  })

  it('rejects the three non-canonical forms 1Sat also rejects', () => {
    const json = (p: object) => Utils.toHex(Utils.toArray(JSON.stringify(p), 'utf8'))
    const push = (h: string) => (h.length / 2 > 0x4b ? '4c' : '') + (h.length / 2).toString(16).padStart(2, '0') + h
    const build = (tag: string, p: object) => LockingScript.fromHex(
      '0063' + push(Utils.toHex(Utils.toArray('ord', 'utf8'))) + tag +
      push(Utils.toHex(Utils.toArray('application/bsv-20', 'utf8'))) + '00' + push(json(p)) + '68' + '76a914' + A + '88ac')
    const ok = { p: 'bsv-20', op: 'transfer', id: `${'aa'.repeat(32)}_0`, amt: '5' }
    expect(decodeBsv21(build('51', ok))).not.toBeNull()
    expect(decodeBsv21(build('0101', ok))).toBeNull() // gate 1: non-minimal OP_1
    expect(decodeBsv21(build('51', { ...ok, amt: 5 }))).toBeNull() // gate 2: number value
    expect(decodeBsv21(build('51', { ...ok, id: `${'aa'.repeat(32)}.0` }))).toBeNull() // gate 3: dot id
  })

  it('refuses to build amounts above uint64', () => {
    expect(() => buildBsv21Script({ op: 'deploy+mint', amt: (MAX_U64 + 1n).toString() }, A)).toThrow()
  })
})

describe('admission rules', () => {
  it('admits a deploy+mint', () => {
    const { tx } = deployTx()
    expect(identifyAdmissible(tx, [])).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
  })

  it('admits an exact transfer and a split, retaining the spent input', () => {
    const { tx: d, tokenId } = deployTx()
    expect(identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: '1000' }]), [0])).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect(identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: '600' }, { id: tokenId, amt: '400', owner: A }]), [0]).outputsToAdmit).toEqual([0, 1])
  })

  it('admits a merge of two admitted UTXOs', () => {
    const { tx: d, tokenId } = deployTx()
    const split = spend(d, 0, [{ id: tokenId, amt: '600' }, { id: tokenId, amt: '400' }])
    const merge = new Transaction()
    merge.addInput({ sourceTransaction: split, sourceOutputIndex: 0, unlockingScript: EMPTY })
    merge.addInput({ sourceTransaction: split, sourceOutputIndex: 1, unlockingScript: EMPTY })
    merge.addOutput({ lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '1000' }, B), satoshis: 1 })
    expect(identifyAdmissible(merge, [0, 1])).toEqual({ outputsToAdmit: [0], coinsToRetain: [0, 1] })
  })

  it('rejects inflation (outputs exceed admitted inputs)', () => {
    const { tx: d, tokenId } = deployTx()
    const r = identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: '1001' }]), [0])
    expect(r.outputsToAdmit).toEqual([])
    expect(r.coinsToRetain).toEqual([0]) // the input is still consumed (tokens burned)
  })

  it('FORGERY: rejects a "transfer" of a real token minted from plain sats', () => {
    const { tokenId } = deployTx()
    const funding = new Transaction()
    funding.addOutput({ lockingScript: new P2PKH().lock(Utils.toArray(A, 'hex')), satoshis: 1000 })
    const forged = new Transaction()
    forged.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: EMPTY })
    forged.addOutput({ lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '1000000' }, B), satoshis: 1 })
    expect(identifyAdmissible(forged, []).outputsToAdmit).toEqual([])
  })

  it('FORGERY: refuses a token input the overlay never admitted', () => {
    const { tokenId } = deployTx()
    const fake = new Transaction() // looks like a token UTXO, but was never admitted
    fake.addOutput({ lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '5000' }, A), satoshis: 1 })
    expect(() => identifyAdmissible(spend(fake, 0, [{ id: tokenId, amt: '5000' }]), [])).toThrow(UnknownTokenInputError)
  })

  it('FORGERY: an admitted input of token X cannot fund outputs of token Y', () => {
    const { tx: dx } = deployTx('1000')
    const { tokenId: idY } = deployTx('7')
    expect(identifyAdmissible(spend(dx, 0, [{ id: idY, amt: '1000' }]), [0]).outputsToAdmit).toEqual([])
  })

  it('rejects an output sum that would overflow uint64', () => {
    const { tx: d, tokenId } = deployTx(MAX_U64.toString())
    const r = identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: MAX_U64.toString() }, { id: tokenId, amt: '2' }]), [0])
    expect(r.outputsToAdmit).toEqual([])
  })

  it('admits a burn covered by inputs, and a burned output carries no balance', () => {
    const { tx: d, tokenId } = deployTx()
    const burn = spend(d, 0, [{ id: tokenId, amt: '900' }, { id: tokenId, amt: '100', op: 'burn' }])
    expect(identifyAdmissible(burn, [0]).outputsToAdmit).toEqual([0, 1])
    const fromBurn = spend(burn, 1, [{ id: tokenId, amt: '100' }])
    expect(identifyAdmissible(fromBurn, [0]).outputsToAdmit).toEqual([])
  })

  it('honours a whitelist', () => {
    const { tx } = deployTx()
    expect(identifyAdmissible(tx, [], { whitelist: new Set(['other_0']) }).outputsToAdmit).toEqual([])
  })
})

describe('deterministic receive keys', () => {
  it('sender-side derivation equals the owner wallet derivation (BRC-42 anyone)', async () => {
    const root = PrivateKey.fromRandom()
    const wallet = new ProtoWallet(root)
    const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
    for (const i of [0, 1, 7]) {
      expect(await ownReceivePublicKey(wallet, i)).toBe(receivePublicKey(identityKey, i).toString())
    }
    expect(receivePublicKey(identityKey, 0).toString()).not.toBe(receivePublicKey(identityKey, 1).toString())
  })
})
