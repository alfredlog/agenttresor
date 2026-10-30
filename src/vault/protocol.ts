/**
 * Key derivation shared by the company (BSV Desktop), the proxy (policy key)
 * and the browser page. Security level 1: these keys control value (BRC-43).
 */
import type { WalletProtocol } from '../shared/bsv.js'

export const VAULT_PROTOCOL: WalletProtocol = [1, 'agenttresor vault']

export function vaultKeyId (agentId: string): string {
  return `agent-${agentId}`
}
