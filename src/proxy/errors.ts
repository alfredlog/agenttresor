/** Machine-readable reasons a client may act on. */
export type ProxyErrorCode = 'VAULT_OPEN' | 'SIGN_WINDOW_EXPIRED' | 'SIGNATURE_PENDING'

/**
 * An error that maps to an HTTP status. The message and `details` are safe to
 * show the caller; they are sent as `{ error: message, ...details }`.
 */
export class ProxyError extends Error {
  constructor (readonly httpStatus: number, message: string, readonly details: { code?: ProxyErrorCode, [k: string]: unknown } = {}) {
    super(message)
  }
}
