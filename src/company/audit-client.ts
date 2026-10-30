/**
 * Company side of the audit log, written against BRC-100's WalletInterface
 * (BSV Desktop in the browser, a wallet-toolbox wallet in tests): anchors the
 * head of the proxy's audit log on BSV. The company's wallet pays the fee; the
 * proxy pays nothing and holds no key.
 */
import { Transaction, Utils, type WalletInterface } from '../shared/bsv.js'
import { anchorLockingScript } from '../audit/anchor-script.js'
import { proxyCall } from './vault-client.js'

export interface AuditHead {
  seq: number
  hash: string
}

export async function getAuditHead (proxyUrl: string, adminToken: string): Promise<AuditHead> {
  return await proxyCall<AuditHead>({ proxyUrl, adminToken }, '/admin/audit/head')
}

export interface AnchorResult extends AuditHead {
  txid: string
}

/** Writes the current head {seq, hash} in an OP_RETURN output and hands the transaction to the proxy. */
export async function anchorAuditHead (wallet: WalletInterface, proxyUrl: string, adminToken: string): Promise<AnchorResult> {
  const head = await getAuditHead(proxyUrl, adminToken)
  if (head.seq < 1) throw new Error('the audit log is empty: nothing to anchor')
  const lockingScript = anchorLockingScript(head.hash, head.seq).toHex()

  const created = await wallet.createAction({
    description: `Anchor AgentTresor audit log #${head.seq}`.slice(0, 50),
    outputs: [{ lockingScript, satoshis: 0, outputDescription: 'AgentTresor audit anchor' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (created.tx === undefined || created.txid === undefined) throw new Error('the wallet did not create the anchor transaction')
  // Find the anchor output by its locking script, never by position.
  if (Transaction.fromAtomicBEEF(created.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript) === -1) {
    throw new Error('anchor output not found in the transaction')
  }
  await proxyCall({ proxyUrl, adminToken }, '/admin/audit/anchors', { beef: Utils.toHex(Array.from(created.tx)) })
  return { ...head, txid: created.txid }
}
