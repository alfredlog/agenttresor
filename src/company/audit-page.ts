/**
 * Browser entry for the dashboard's "Anchor now with BSV Desktop" button.
 * Bundled by `npm run build:web` into public/audit.js and loaded on demand.
 */
import { WalletClient } from '../shared/bsv.js'
import { anchorAuditHead, type AnchorResult } from './audit-client.js'

export async function anchorNow (proxyUrl: string, adminToken: string): Promise<AnchorResult> {
  return await anchorAuditHead(new WalletClient('auto'), proxyUrl, adminToken)
}
