/**
 * Proxy side of anchoring: checks an anchor transaction made by the company's
 * wallet and records it. The proxy never builds or pays for it.
 */
import { Transaction, Utils, type ChainTracker } from '../shared/bsv.js'
import { ProxyError } from '../proxy/errors.js'
import { parseAnchorScript } from './anchor-script.js'
import type { AuditAnchor, AuditLog } from './log.js'

export async function recordAnchor (audit: AuditLog, chainTracker: ChainTracker, body: { beef?: unknown }, now: number): Promise<AuditAnchor> {
  if (typeof body.beef !== 'string' || !/^([0-9a-f]{2})+$/i.test(body.beef)) throw new ProxyError(400, 'beef must be AtomicBEEF hex')
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(Utils.toArray(body.beef, 'hex'))
  } catch (err) {
    throw new ProxyError(400, `beef is not valid AtomicBEEF: ${err instanceof Error ? err.message : String(err)}`)
  }
  let valid = false
  try { valid = await tx.verify(chainTracker) } catch {}
  if (!valid) throw new ProxyError(400, 'the anchor transaction failed SPV verification')

  const anchored = tx.outputs.map(o => parseAnchorScript(o.lockingScript)).filter(a => a !== undefined)
  if (anchored.length !== 1) throw new ProxyError(400, 'the transaction must have exactly one AgentTresor audit OP_RETURN output')
  const { seq, hash } = anchored[0]!

  const entry = await audit.get(seq)
  if (entry === undefined) throw new ProxyError(400, `the audit log has no entry ${seq}`)
  if (entry.hash !== hash) throw new ProxyError(400, `the anchored hash does not match audit entry ${seq}`)

  const txid = tx.id('hex')
  if ((await audit.anchors()).some(a => a.txid === txid)) throw new ProxyError(409, 'this anchor is already recorded')
  const anchor: AuditAnchor = { seq, hash, txid, at: now, source: 'company', feeSats: null }
  // The anchor and its own log entry are written together.
  await audit.transaction(async a => {
    await a.addAnchor(anchor)
    await a.append('company', 'audit.anchor_recorded', { seq, hash, txid })
  })
  return anchor
}
