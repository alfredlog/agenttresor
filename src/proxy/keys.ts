/**
 * Agent API keys: "agt_" + 32 random bytes hex. Only the sha256 is stored; the
 * key is shown once at creation and masked (agt_ab12…) everywhere else.
 */
import { createHash, randomBytes } from 'node:crypto'

const KEY_PATTERN = /^agt_[0-9a-f]{64}$/

export function generateAgentKey (): string {
  return `agt_${randomBytes(32).toString('hex')}`
}

export function isAgentKey (value: string): boolean {
  return KEY_PATTERN.test(value)
}

export function hashAgentKey (key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** The visible part of a key: "agt_" + 4 hex chars (16 bits, not enough to guess the key). */
export function agentKeyHint (key: string): string {
  return key.slice(0, 8)
}

export function maskAgentKey (hint: string): string {
  return `${hint}…`
}
