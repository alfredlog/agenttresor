/**
 * Browser entry for the dashboard's "Anchor now with BSV Desktop" and
 * "Top up notary from BSV Desktop" buttons.
 * Bundled by `npm run build:web` into public/audit.js and loaded on demand.
 */
import { WalletClient } from '../shared/bsv.js'
import { anchorAuditHead, type AnchorResult } from './audit-client.js'
import { topUpNotary, type TopUpResult } from './notary-client.js'

export async function anchorNow (proxyUrl: string, adminToken: string): Promise<AnchorResult> {
  return await anchorAuditHead(new WalletClient('auto'), proxyUrl, adminToken)
}

export async function topUpNotaryNow (proxyUrl: string, adminToken: string, satoshis: number): Promise<TopUpResult> {
  return await topUpNotary(new WalletClient('auto'), proxyUrl, adminToken, satoshis)
}
