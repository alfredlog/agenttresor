/**
 * Agent key fingerprint: first 6 bytes of sha256(compressed public key), hex
 * uppercase, as XXXX-XXXX-XXXX. A human compares it on the agent's machine
 * (printed by the MCP agent) with the one vault.html computes before funding,
 * so the company never funds a key the proxy swapped in.
 * One function for the agent, the dashboard and vault.html (bundled for the browser).
 */
import { Hash, Utils } from './bsv.js'

const COMPRESSED_PUB = /^0[23][0-9a-fA-F]{64}$/
const FINGERPRINT = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/

export function fingerprint (publicKeyHex: string): string {
  if (!COMPRESSED_PUB.test(publicKeyHex)) throw new Error('not a compressed public key')
  const hex = Utils.toHex(Hash.sha256(Utils.toArray(publicKeyHex.toLowerCase(), 'hex')).slice(0, 6)).toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

export function isFingerprint (value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value)
}

/**
 * Funding guard: the company only funds the agent key whose fingerprint a human
 * confirmed on the agent's machine. `agentPub` is the key about to be funded
 * (as fetched at funding time), `confirmed` the fingerprint the human checked.
 */
export function requireConfirmedFingerprint (agentPub: string, confirmed: string | null | undefined): void {
  if (confirmed === null || confirmed === undefined || confirmed === '') {
    throw new Error('check the agent key fingerprint on the agent\'s machine and confirm it before funding')
  }
  const actual = fingerprint(agentPub)
  if (actual !== confirmed.trim().toUpperCase()) {
    throw new Error(`the agent key changed: its fingerprint is ${actual}, not the confirmed ${confirmed}. Check it again on the agent's machine`)
  }
}
