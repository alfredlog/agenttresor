/** The agent key fingerprint and the funding guard built on it. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { confirmedFingerprint } from '../src/company/vault-client'
import { fingerprint, isFingerprint, requireConfirmedFingerprint } from '../src/shared/fingerprint'

const pub = PrivateKey.fromRandom().toPublicKey().toString()
const other = PrivateKey.fromRandom().toPublicKey().toString()

describe('fingerprint()', () => {
  it('is the first 6 bytes of sha256(compressed key), uppercase, XXXX-XXXX-XXXX', () => {
    const hex = createHash('sha256').update(Buffer.from(pub, 'hex')).digest('hex').slice(0, 12).toUpperCase()
    expect(fingerprint(pub)).toBe(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`)
    expect(isFingerprint(fingerprint(pub))).toBe(true)
  })

  it('is stable and differs for different keys', () => {
    expect(fingerprint(pub)).toBe(fingerprint(pub))
    expect(fingerprint(pub.toUpperCase().replace(/^0([23])/, '0$1'))).toBe(fingerprint(pub)) // hex case does not matter
    expect(fingerprint(other)).not.toBe(fingerprint(pub))
  })

  it('accepts only compressed public keys', () => {
    expect(() => fingerprint('04' + 'ab'.repeat(64))).toThrow(/compressed/)
    expect(() => fingerprint('not a key')).toThrow(/compressed/)
  })
})

describe('funding guard', () => {
  it('refuses without a confirmation, or with another key\'s fingerprint', () => {
    expect(() => requireConfirmedFingerprint(pub, null)).toThrow(/confirm it before funding/)
    expect(() => requireConfirmedFingerprint(pub, '')).toThrow(/confirm it before funding/)
    expect(() => requireConfirmedFingerprint(pub, fingerprint(other))).toThrow(/agent key changed/)
    expect(() => requireConfirmedFingerprint(pub, fingerprint(pub))).not.toThrow()
  })

  it('the page passes the shown fingerprint only when the box is ticked', () => {
    expect(confirmedFingerprint(fingerprint(pub), false)).toBeNull()
    expect(confirmedFingerprint(null, true)).toBeNull()
    expect(confirmedFingerprint('whatever', true)).toBeNull()
    expect(confirmedFingerprint(fingerprint(pub), true)).toBe(fingerprint(pub))
  })
})
