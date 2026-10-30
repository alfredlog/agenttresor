/** An error that maps to an HTTP status (the message is safe to show the caller). */
export class ProxyError extends Error {
  constructor (readonly httpStatus: number, message: string) { super(message) }
}
