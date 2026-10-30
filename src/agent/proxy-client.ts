/**
 * HTTP client for the proxy's agent API (Bearer agt_…). Answers are returned
 * as { status, body } because the payment flow depends on the status code.
 * The API key never appears in an error message: it is masked (agt_ab12…).
 */
export interface ProxyResponse {
  status: number
  body: any
}

export interface ProxyClientOptions {
  proxyUrl: string
  apiKey: string
  /** For tests: a fetch that can observe or alter traffic. */
  fetch?: typeof fetch
}

export function maskApiKey (key: string): string {
  return `${key.slice(0, 8)}…`
}

export class ProxyClient {
  private readonly url: string
  private readonly apiKey: string
  private readonly fetch: typeof fetch

  constructor (opts: ProxyClientOptions) {
    if (!/^agt_[0-9a-f]{64}$/.test(opts.apiKey)) throw new Error('AGENT_API_KEY must be an agent key (agt_ followed by 64 hex chars)')
    this.url = opts.proxyUrl.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.fetch = opts.fetch ?? fetch
  }

  async registerKey (publicKey: string): Promise<ProxyResponse> {
    return await this.request('POST', '/v1/vault/agent-key', { publicKey })
  }

  async pay (input: { url: string, method?: string, body?: unknown, purpose: string }): Promise<ProxyResponse> {
    return await this.request('POST', '/v1/pay', input)
  }

  async execute (requestId: string): Promise<ProxyResponse> {
    return await this.request('POST', `/v1/requests/${encodeURIComponent(requestId)}/execute`, {})
  }

  async sign (requestId: string, signature: string): Promise<ProxyResponse> {
    return await this.request('POST', `/v1/requests/${encodeURIComponent(requestId)}/sign`, { signature })
  }

  async getRequest (requestId: string): Promise<ProxyResponse> {
    return await this.request('GET', `/v1/requests/${encodeURIComponent(requestId)}`)
  }

  async budget (): Promise<ProxyResponse> {
    return await this.request('GET', '/v1/budget')
  }

  /** The merchants this agent may pay: [{ name, url, catalogUrl }]. */
  async services (): Promise<ProxyResponse> {
    return await this.request('GET', '/v1/services')
  }

  private async request (method: string, path: string, body?: unknown): Promise<ProxyResponse> {
    try {
      const res = await this.fetch(`${this.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    } catch (err) {
      throw new Error(this.mask(`proxy request ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private mask (text: string): string {
    return text.split(this.apiKey).join(maskApiKey(this.apiKey))
  }
}
