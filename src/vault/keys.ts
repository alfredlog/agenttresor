/**
 * Proxy-side keys, all derived from PROXY_ROOT_KEY:
 *  - the policy key of each vault ([1, 'agenttresor vault'], `agent-<id>`, 'self');
 *  - the proxy identity key, the BRC-29 sender of every vault payment.
 * The policy key alone can never move vault funds (see ./script.ts).
 */
import { KeyDeriver, type PrivateKey, type PublicKey } from '../shared/bsv.js'
import { BRC29_PROTOCOL_ID } from '../shared/brc121.js'
import { VAULT_PROTOCOL, vaultKeyId } from './protocol.js'

export class PolicyKeys {
  private readonly deriver: KeyDeriver
  readonly identityKey: string

  constructor (rootKey: PrivateKey) {
    this.deriver = new KeyDeriver(rootKey)
    this.identityKey = rootKey.toPublicKey().toString()
  }

  policyKey (agentId: string): PrivateKey {
    return this.deriver.derivePrivateKey(VAULT_PROTOCOL, vaultKeyId(agentId), 'self')
  }

  policyPub (agentId: string): string {
    return this.policyKey(agentId).toPublicKey().toString()
  }

  /** The merchant's BRC-29 key for `keyID`, as @bsv/402-pay's constructPaymentHeaders derives it. */
  merchantPaymentKey (serverKey: string, keyID: string): PublicKey {
    return this.deriver.derivePublicKey(BRC29_PROTOCOL_ID, keyID, serverKey, false)
  }
}
