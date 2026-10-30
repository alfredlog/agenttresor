/** Verifies the audit log of a proxy database file (read-only use): the full chain, every anchor, the tail. */
import { existsSync } from 'node:fs'
import { openProxyDb } from '../proxy/store.js'
import { AuditLog, type AuditStatus, type AuditVerifyReport } from './log.js'

export type AuditReport = AuditVerifyReport & { head: AuditStatus }

export async function verifyDatabase (filename: string): Promise<AuditReport> {
  if (!existsSync(filename)) throw new Error(`${filename} does not exist`)
  const db = await openProxyDb(filename)
  try {
    const audit = new AuditLog(db)
    return { ...await audit.verify({ full: true }), head: await audit.status() }
  } finally {
    await db.destroy()
  }
}
