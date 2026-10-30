/** Verifies the audit log of a proxy database file (read-only use). */
import { existsSync } from 'node:fs'
import { openProxyDb } from '../proxy/store.js'
import { AuditLog, type AuditAnchor, type ChainCheck } from './log.js'

export type AuditReport = ChainCheck & { head: { seq: number, hash: string }, anchors: Array<AuditAnchor & { matches: boolean }> }

export async function verifyDatabase (filename: string): Promise<AuditReport> {
  if (!existsSync(filename)) throw new Error(`${filename} does not exist`)
  const db = await openProxyDb(filename)
  try {
    const audit = new AuditLog(db)
    return { ...await audit.verify(), head: await audit.head() }
  } finally {
    await db.destroy()
  }
}
