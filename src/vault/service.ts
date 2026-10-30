/**
 * Proxy side of the non-custodial vault.
 *
 * The company funds a vault UTXO per agent from its own wallet; every payment
 * spends it straight to the merchant, with change back to the same script.
 * A payment needs two signatures: the agent signs on its side (it never sends
 * its key), then the proxy adds the policy signature and broadcasts. The
 * proxy alone cannot move funds; the company alone can always reclaim.
 */
import { Beef, LockingScript, P2PKH, Random, Transaction, Utils, type ChainTracker } from '../shared/bsv.js'
import type { PaymentHeaders } from '../shared/brc121.js'
import { ProxyError } from '../proxy/errors.js'
import type { Broadcaster } from './broadcaster.js'
import { buildRequestVaultPayment, buildVaultPayment, requestVaultFee, type VaultOutpoint } from './builder.js'
import type { PolicyKeys } from './keys.js'
import { VAULT_PROTOCOL, vaultKeyId } from './protocol.js'
import { signatureFromDerHex, signVaultInput, spendUnlockingScript, vaultLockingScript, verifyVaultSignature } from './script.js'
import type { RequestVault, RequestVaultStatus, Vault, VaultStore, VaultTx } from './store.js'

/**
 * A signature must come back within this long after the transaction was built:
 * BRC-121 merchants accept a payment for 30 s after its timestamp.
 */
export const SIGN_WINDOW_MS = 20_000

/** What the agent receives to sign (POST /v1/pay or /execute answer, status 'sign'). */
export interface SignRequest {
  unsignedTx: string
  sourceSatoshis: number
  sourceLockingScript: string
  merchantOutput: { satoshis: number, lockingScript: string }
  feeSats: number
}

export interface FinalizedPayment {
  txid: string
  priceSats: number
  feeSats: number
  headers: PaymentHeaders
}

export interface VaultServiceOptions {
  store: VaultStore
  policy: PolicyKeys
  chainTracker: ChainTracker
  broadcaster: Broadcaster
  now: () => number
}

const isCompressedPubHex = (v: unknown): v is string => typeof v === 'string' && /^0[23][0-9a-f]{64}$/.test(v)

/** A company funding transaction: AtomicBEEF hex, the vault output index, the company's derived key. */
export interface FundingBody { beef?: unknown, vout?: unknown, companyPub?: unknown }

/** The UTXO a payment spends: the agent's vault, or a request vault. */
interface SpendSource {
  kind: 'agent' | 'request'
  txid: string
  vout: number
  satoshis: number
  lockingScript: string
  beefHex: string
}

export interface ReclaimableUtxo {
  outpoint: string
  satoshis: number
  lockingScript: string
  beef: string
  protocolID: typeof VAULT_PROTOCOL
  keyID: string
}
const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)

export class VaultService {
  private readonly store: VaultStore
  private readonly policy: PolicyKeys
  private readonly chainTracker: ChainTracker
  private readonly broadcaster: Broadcaster
  private readonly now: () => number

  constructor (opts: VaultServiceOptions) {
    this.store = opts.store
    this.policy = opts.policy
    this.chainTracker = opts.chainTracker
    this.broadcaster = opts.broadcaster
    this.now = opts.now
  }

  get senderIdentityKey (): string {
    return this.policy.identityKey
  }

  /** POST /v1/vault/agent-key: the agent registers the public key it signs with. */
  async registerAgentKey (agentId: string, publicKey: unknown): Promise<Vault> {
    if (!isCompressedPubHex(publicKey)) throw new ProxyError(400, 'publicKey must be a compressed public key (66 hex chars)')
    const vault = await this.store.getVault(agentId)
    // The registered key is public; returning it lets an agent see whether its own key is the one in use.
    if (vault?.status === 'open') throw new ProxyError(409, 'the vault is funded with the current key; the company must reclaim it first', { code: 'VAULT_OPEN', agentPub: vault.agentPub })
    await this.store.setAgentKey(agentId, publicKey, this.now())
    return (await this.store.getVault(agentId))!
  }

  /** GET /admin/vaults/:agentId/params: what the company needs to build the vault script. */
  async params (agentId: string): Promise<{ agentId: string, agentPub: string, policyPub: string, protocolID: typeof VAULT_PROTOCOL, keyID: string }> {
    const vault = await this.store.getVault(agentId)
    if (vault === undefined) throw new ProxyError(409, 'the agent has not registered its public key yet')
    if (vault.status === 'open') throw new ProxyError(409, 'the vault is already funded; reclaim it before funding again')
    return { agentId, agentPub: vault.agentPub, policyPub: this.policy.policyPub(agentId), protocolID: VAULT_PROTOCOL, keyID: vaultKeyId(agentId) }
  }

  /** POST /admin/vaults/:agentId/funded: verify the funding transaction with SPV and the script, then open the vault. */
  async acceptFunding (agentId: string, body: FundingBody): Promise<Vault> {
    const vault = await this.store.getVault(agentId)
    if (vault === undefined) throw new ProxyError(409, 'the agent has not registered its public key yet')
    if (vault.status === 'open') throw new ProxyError(409, 'the vault is already funded')
    const f = await this.verifyFunding(agentId, vault.agentPub, body)
    if (f.satoshis < 1) throw new ProxyError(400, 'the vault output holds no satoshis')

    const now = this.now()
    await this.store.insertTx({ ...emptyTx(agentId, now), kind: 'fund', status: 'done', txid: f.txid, priceSats: f.satoshis })
    return await this.store.updateVault(agentId, {
      companyPub: f.companyPub,
      lockingScript: f.lockingScript,
      status: 'open',
      txid: f.txid,
      vout: f.vout,
      satoshis: f.satoshis,
      beefHex: f.beefHex,
      updatedAt: now
    })
  }

  // ── Request vaults: the company approves a payment by funding exactly it ──

  /** GET /admin/requests/:id/approval: what the company must fund to approve a payment of `priceSats`. */
  async approvalInfo (agentId: string, priceSats: number): Promise<{ agentPub: string, policyPub: string, protocolID: typeof VAULT_PROTOCOL, keyID: string, feeSats: number, totalSats: number }> {
    const vault = await this.store.getVault(agentId)
    if (vault === undefined) throw new ProxyError(409, 'the agent has not registered its public key yet')
    const feeSats = await requestVaultFee()
    return { agentPub: vault.agentPub, policyPub: this.policy.policyPub(agentId), protocolID: VAULT_PROTOCOL, keyID: vaultKeyId(agentId), feeSats, totalSats: priceSats + feeSats }
  }

  /**
   * POST /admin/requests/:id/approve: the company funded a request vault for
   * this payment. Checked by SPV, exact script and exact amount (price + fee).
   */
  async fundRequest (agentId: string, requestId: string, priceSats: number, body: FundingBody): Promise<RequestVault> {
    if (await this.store.getRequestVault(requestId) !== undefined) throw new ProxyError(409, 'this request is already funded')
    const vault = await this.store.getVault(agentId)
    if (vault === undefined) throw new ProxyError(409, 'the agent has not registered its public key yet')
    const f = await this.verifyFunding(agentId, vault.agentPub, body)
    if (vault.companyPub !== null && f.companyPub !== vault.companyPub) {
      throw new ProxyError(400, 'companyPub differs from the company key of this agent\'s vault')
    }
    const { totalSats } = await this.approvalInfo(agentId, priceSats)
    if (f.satoshis !== totalSats) throw new ProxyError(400, `the request vault holds ${f.satoshis} sats; approving this payment takes exactly ${totalSats}`)

    const now = this.now()
    const rv: RequestVault = {
      requestId,
      agentId,
      txid: f.txid,
      vout: f.vout,
      satoshis: f.satoshis,
      lockingScript: f.lockingScript,
      companyPub: f.companyPub,
      beefHex: f.beefHex,
      status: 'open',
      closingTxid: null,
      createdAt: now,
      updatedAt: now
    }
    await this.store.insertRequestVault(rv)
    await this.store.insertTx({ ...emptyTx(agentId, now), requestId, kind: 'fund', status: 'done', txid: f.txid, priceSats: f.satoshis })
    return rv
  }

  async requestVault (requestId: string): Promise<RequestVault | undefined> {
    return await this.store.getRequestVault(requestId)
  }

  async listRequestVaults (status?: RequestVaultStatus): ReturnType<VaultStore['listRequestVaults']> {
    return await this.store.listRequestVaults(status === undefined ? {} : { status })
  }

  /** GET /admin/request-vaults/:requestId/utxo: what the company needs to reclaim a request vault alone. */
  async requestVaultUtxo (requestId: string): Promise<ReclaimableUtxo> {
    const rv = await this.openRequestVault(requestId)
    return {
      outpoint: `${rv.txid}.${rv.vout}`,
      satoshis: rv.satoshis,
      lockingScript: rv.lockingScript,
      beef: rv.beefHex,
      protocolID: VAULT_PROTOCOL,
      keyID: vaultKeyId(rv.agentId)
    }
  }

  /** POST /admin/request-vaults/:requestId/reclaimed: the company took the approval funds back. */
  async markRequestVaultReclaimed (requestId: string, txid: unknown): Promise<RequestVault> {
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) throw new ProxyError(400, 'txid must be a transaction id')
    const rv = await this.openRequestVault(requestId)
    const now = this.now()
    for (const attempt of await this.store.awaitingSignature(rv.agentId)) {
      if (attempt.requestId === requestId) await this.store.updateTx(attempt.id, { status: 'failed', reason: 'request vault reclaimed', updatedAt: now })
    }
    await this.store.insertTx({ ...emptyTx(rv.agentId, now), requestId, kind: 'reclaim', status: 'done', txid, inputOutpoint: `${rv.txid}.${rv.vout}`, priceSats: rv.satoshis })
    return await this.store.updateRequestVault(requestId, { status: 'reclaimed', closingTxid: txid, updatedAt: now })
  }

  /** GET /admin/vaults/:agentId/utxo: what the company needs to reclaim alone. */
  async utxo (agentId: string): Promise<ReclaimableUtxo> {
    const vault = await this.openVault(agentId)
    return {
      outpoint: `${vault.txid!}.${vault.vout!}`,
      satoshis: vault.satoshis!,
      lockingScript: vault.lockingScript!,
      beef: vault.beefHex!,
      protocolID: VAULT_PROTOCOL,
      keyID: vaultKeyId(agentId)
    }
  }

  /** POST /admin/vaults/:agentId/reclaimed: the company took the funds back. */
  async markReclaimed (agentId: string, txid: unknown): Promise<Vault> {
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) throw new ProxyError(400, 'txid must be a transaction id')
    const vault = await this.openVault(agentId)
    const now = this.now()
    for (const attempt of await this.store.awaitingSignature(agentId)) {
      await this.store.updateTx(attempt.id, { status: 'failed', reason: 'vault reclaimed', updatedAt: now })
    }
    await this.store.insertTx({ ...emptyTx(agentId, now), kind: 'reclaim', status: 'done', txid, inputOutpoint: `${vault.txid!}.${vault.vout!}`, priceSats: vault.satoshis })
    return await this.store.updateVault(agentId, { status: 'closed', updatedAt: now })
  }

  async balance (agentId: string): Promise<{ status: string, satoshis: number, outpoint: string | null }> {
    const vault = await this.store.getVault(agentId)
    if (vault === undefined) return { status: 'none', satoshis: 0, outpoint: null }
    const open = vault.status === 'open'
    return { status: vault.status, satoshis: open ? vault.satoshis! : 0, outpoint: open ? `${vault.txid!}.${vault.vout!}` : null }
  }

  /** Why the vault cannot pay `sats` (the on-chain hard cap), or undefined if it can. */
  async capacityProblem (agentId: string, sats: number): Promise<string | undefined> {
    const vault = await this.store.getVault(agentId)
    if (vault?.status !== 'open') return 'the agent has no funded vault'
    const { feeSats, changeSats } = await buildVaultPayment(outpointOf(vault), sats)
    // At least 1 sat stays in the vault, so it always has an output to spend next.
    if (changeSats < 1) return `vault balance too low: ${sats} + ${feeSats} fee needs more than the ${vault.satoshis!} sats in the vault`
    return undefined
  }

  /** A payment of this agent waiting for a signature. Stale attempts are expired on the way. */
  async inFlight (agentId: string): Promise<VaultTx | undefined> {
    const now = this.now()
    let live: VaultTx | undefined
    for (const attempt of await this.store.awaitingSignature(agentId)) {
      if (now - attempt.createdAt > SIGN_WINDOW_MS) {
        await this.store.updateTx(attempt.id, { status: 'expired', reason: 'no signature in time', updatedAt: now })
      } else {
        live = attempt
      }
    }
    return live
  }

  /** Builds the payment of `sats` to the merchant `serverKey` and keeps it until the agent signs. */
  async prepare (agentId: string, requestId: string, sats: number, serverKey: string): Promise<SignRequest> {
    if (await this.inFlight(agentId) !== undefined) throw new ProxyError(409, 'a vault payment is already waiting for a signature', { code: 'SIGNATURE_PENDING' })
    const vault = await this.openVault(agentId)

    const now = this.now()
    const { nonce, time, merchantScript } = this.merchantOutput(serverKey, now)
    const { tx, feeSats, changeSats } = await buildVaultPayment(outpointOf(vault), sats, merchantScript)
    if (changeSats < 1) throw new ProxyError(403, `vault balance too low: ${sats} + ${feeSats} fee needs more than the ${vault.satoshis!} sats in the vault`)

    const unsignedTx = tx.toHex()
    await this.store.insertTx({
      ...emptyTx(agentId, now),
      requestId,
      kind: 'payment',
      status: 'awaiting_signature',
      inputOutpoint: `${vault.txid!}.${vault.vout!}`,
      unsignedTx,
      priceSats: sats,
      feeSats,
      changeSats,
      serverKey,
      nonce,
      timeMs: time
    })
    return {
      unsignedTx,
      sourceSatoshis: vault.satoshis!,
      sourceLockingScript: vault.lockingScript!,
      merchantOutput: { satoshis: sats, lockingScript: merchantScript.toHex() },
      feeSats
    }
  }

  /**
   * Builds the payment of an approved request from its request vault: one
   * input, one output paying the merchant exactly `sats`; the rest is the fee
   * the company funded. The agent's own vault is not touched.
   */
  async prepareFromRequestVault (agentId: string, requestId: string, sats: number, serverKey: string): Promise<SignRequest> {
    if (await this.inFlight(agentId) !== undefined) throw new ProxyError(409, 'a vault payment is already waiting for a signature', { code: 'SIGNATURE_PENDING' })
    const rv = await this.openRequestVault(requestId)
    const now = this.now()
    const { nonce, time, merchantScript } = this.merchantOutput(serverKey, now)
    const { tx, feeSats } = buildRequestVaultPayment({ txid: rv.txid, vout: rv.vout, satoshis: rv.satoshis, lockingScript: rv.lockingScript }, sats, merchantScript)
    if (feeSats < 1) throw new ProxyError(409, `the request vault holds ${rv.satoshis} sats, not enough for ${sats} plus a fee`)

    const unsignedTx = tx.toHex()
    await this.store.insertTx({
      ...emptyTx(agentId, now),
      requestId,
      kind: 'payment',
      status: 'awaiting_signature',
      inputOutpoint: `${rv.txid}.${rv.vout}`,
      unsignedTx,
      priceSats: sats,
      feeSats,
      changeSats: 0,
      serverKey,
      nonce,
      timeMs: time
    })
    return {
      unsignedTx,
      sourceSatoshis: rv.satoshis,
      sourceLockingScript: rv.lockingScript,
      merchantOutput: { satoshis: sats, lockingScript: merchantScript.toHex() },
      feeSats
    }
  }

  /**
   * Checks the agent's signature, adds the policy signature and broadcasts.
   * The agent's vault moves to its change output; a request vault is closed.
   * Returns the BRC-121 payment headers.
   */
  async finalize (agentId: string, requestId: string, signatureHex: unknown): Promise<FinalizedPayment> {
    const now = this.now()
    const attempt = (await this.store.awaitingSignature(agentId)).find(a => a.requestId === requestId)
    if (attempt === undefined) throw new ProxyError(409, 'no payment is waiting for a signature for this request; call execute again', { code: 'SIGN_WINDOW_EXPIRED' })
    if (now - attempt.createdAt > SIGN_WINDOW_MS) {
      await this.store.updateTx(attempt.id, { status: 'expired', reason: 'signature arrived too late', updatedAt: now })
      throw new ProxyError(409, `signature arrived more than ${SIGN_WINDOW_MS / 1000} s after the payment was built; call execute to build it again`, { code: 'SIGN_WINDOW_EXPIRED' })
    }
    const vault = await this.store.getVault(agentId)
    const source = await this.sourceOf(agentId, requestId, vault)
    if (vault === undefined || source === undefined || `${source.txid}.${source.vout}` !== attempt.inputOutpoint) {
      await this.store.updateTx(attempt.id, { status: 'failed', reason: 'the vault changed', updatedAt: now })
      throw new ProxyError(409, 'the vault changed since the payment was built')
    }

    const tx = Transaction.fromHex(attempt.unsignedTx!)
    const lockingScript = LockingScript.fromHex(source.lockingScript)
    let agentSig
    try {
      agentSig = signatureFromDerHex(String(signatureHex ?? ''))
    } catch {
      throw new ProxyError(400, 'signature must be a DER signature in hex')
    }
    // Nothing is broadcast unless the agent really signed this exact transaction.
    if (!verifyVaultSignature(vault.agentPub, agentSig, tx, 0, source.satoshis, lockingScript)) {
      throw new ProxyError(400, 'the signature does not match the agent key and this transaction')
    }
    const policySig = signVaultInput(this.policy.policyKey(agentId), tx, 0, source.satoshis, lockingScript)

    const beef = Beef.fromString(source.beefHex, 'hex')
    tx.inputs[0].sourceTransaction = beef.findAtomicTransaction(source.txid)
    tx.inputs[0].unlockingScript = spendUnlockingScript(policySig, agentSig)
    beef.mergeTransaction(tx)
    const txid = tx.id('hex')
    const atomicBeef = beef.toBinaryAtomic(txid)

    try {
      await this.broadcaster.broadcast(atomicBeef, txid)
    } catch (err) {
      await this.store.updateTx(attempt.id, { status: 'failed', reason: `broadcast failed: ${errorMessage(err)}`, updatedAt: now })
      throw new ProxyError(502, `broadcast failed: ${errorMessage(err)}`)
    }

    await this.store.updateTx(attempt.id, { status: 'broadcast', txid, updatedAt: now })
    if (source.kind === 'request') {
      await this.store.updateRequestVault(requestId, { status: 'spent', closingTxid: txid, updatedAt: now })
    } else {
      await this.store.updateVault(agentId, { txid, vout: 1, satoshis: attempt.changeSats!, beefHex: beef.toHex(), updatedAt: now })
    }
    return {
      txid,
      priceSats: attempt.priceSats!,
      feeSats: attempt.feeSats!,
      headers: {
        'x-bsv-beef': Utils.toBase64(atomicBeef),
        'x-bsv-sender': this.policy.identityKey,
        'x-bsv-nonce': attempt.nonce!,
        'x-bsv-time': attempt.timeMs!,
        'x-bsv-vout': '0'
      }
    }
  }

  async listVaults (): ReturnType<VaultStore['listVaults']> {
    return await this.store.listVaults()
  }

  /** The UTXO this request's payment spends: its open request vault if it has one, else the agent's open vault. */
  private async sourceOf (agentId: string, requestId: string, vault: Vault | undefined): Promise<SpendSource | undefined> {
    const rv = await this.store.getRequestVault(requestId)
    if (rv !== undefined) {
      return rv.status === 'open' && rv.agentId === agentId
        ? { kind: 'request', txid: rv.txid, vout: rv.vout, satoshis: rv.satoshis, lockingScript: rv.lockingScript, beefHex: rv.beefHex }
        : undefined
    }
    if (vault?.status !== 'open') return undefined
    return { kind: 'agent', txid: vault.txid!, vout: vault.vout!, satoshis: vault.satoshis!, lockingScript: vault.lockingScript!, beefHex: vault.beefHex! }
  }

  /** The merchant's BRC-29 output, derived exactly as @bsv/402-pay's client does it, with the proxy as sender. */
  private merchantOutput (serverKey: string, now: number): { nonce: string, time: string, merchantScript: LockingScript } {
    const nonce = Utils.toBase64(Random(8))
    const time = String(now)
    const keyID = `${nonce} ${Utils.toBase64(Utils.toArray(time, 'utf8'))}`
    return { nonce, time, merchantScript: new P2PKH().lock(this.policy.merchantPaymentKey(serverKey, keyID).toHash()) }
  }

  /** SPV, then the exact vault script of this agent (agent + policy | company). */
  private async verifyFunding (agentId: string, agentPub: string, body: FundingBody): Promise<{ txid: string, vout: number, satoshis: number, lockingScript: string, companyPub: string, beefHex: string }> {
    if (typeof body.beef !== 'string' || !/^([0-9a-f]{2})+$/i.test(body.beef)) throw new ProxyError(400, 'beef must be AtomicBEEF hex')
    if (!Number.isSafeInteger(body.vout) || (body.vout as number) < 0) throw new ProxyError(400, 'vout must be an output index')
    if (!isCompressedPubHex(body.companyPub)) throw new ProxyError(400, 'companyPub must be a compressed public key')
    const vout = body.vout as number

    let tx: Transaction
    try {
      tx = Transaction.fromAtomicBEEF(Utils.toArray(body.beef, 'hex'))
    } catch (err) {
      throw new ProxyError(400, `beef is not valid AtomicBEEF: ${errorMessage(err)}`)
    }
    let valid = false
    try { valid = await tx.verify(this.chainTracker) } catch {}
    if (!valid) throw new ProxyError(400, 'the funding transaction failed SPV verification')

    const expected = vaultLockingScript({ agentPub, policyPub: this.policy.policyPub(agentId), companyPub: body.companyPub })
    const output = tx.outputs[vout]
    if (output === undefined || output.lockingScript.toHex() !== expected.toHex()) {
      throw new ProxyError(400, 'the funded output is not this agent\'s vault script')
    }
    return {
      txid: tx.id('hex'),
      vout,
      satoshis: output.satoshis ?? 0,
      lockingScript: expected.toHex(),
      companyPub: body.companyPub,
      beefHex: Beef.fromBinary(Utils.toArray(body.beef, 'hex')).toHex()
    }
  }

  private async openRequestVault (requestId: string): Promise<RequestVault> {
    const rv = await this.store.getRequestVault(requestId)
    if (rv?.status !== 'open') throw new ProxyError(409, 'this request has no open request vault')
    return rv
  }

  private async openVault (agentId: string): Promise<Vault> {
    const vault = await this.store.getVault(agentId)
    if (vault?.status !== 'open') throw new ProxyError(409, 'the agent has no funded vault')
    return vault
  }
}

function outpointOf (vault: Vault): VaultOutpoint {
  return { txid: vault.txid!, vout: vault.vout!, satoshis: vault.satoshis!, lockingScript: vault.lockingScript! }
}

function emptyTx (agentId: string, now: number): Omit<VaultTx, 'id' | 'kind' | 'status'> {
  return {
    agentId,
    requestId: null,
    txid: null,
    inputOutpoint: null,
    unsignedTx: null,
    priceSats: null,
    feeSats: null,
    changeSats: null,
    serverKey: null,
    nonce: null,
    timeMs: null,
    reason: null,
    createdAt: now,
    updatedAt: now
  }
}
