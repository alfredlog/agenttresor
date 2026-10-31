/**
 * The local agent service: one HTTP server hosting every agent profile.
 *
 *   /agents/<agentId>/mcp                 MCP (Streamable HTTP, stateless)
 *   /agents/<agentId>/v1/…                plain HTTP API (src/service/api.ts)
 *   /agents/<agentId>/s/<secret>/…        the same, through a public tunnel
 *   /health                               local only: is the service up
 *
 * Each agent has its own MCP server, payer and key. Access rules are in
 * access.ts. URLs are never logged: the tunnel secret can be part of them.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { bearerOf, decideAccess, isForwarded, isLoopbackAddress, isLoopbackHost } from './access.js'
import { createAgentApiRouter } from './api.js'
import type { AgentRegistry, AgentRuntime } from './registry.js'

export interface AgentServiceOptions {
  registry: AgentRegistry
  /** The address the service listens on (default 127.0.0.1). */
  host?: string
  /** MCP_TOKEN: required when `host` is not a loopback address. */
  token?: string
  log?: (msg: string) => void
}

const isMcpPath = (req: Request): boolean => req.path === '/mcp'

function reject (req: Request, res: Response, status: number, message: string): void {
  if (isMcpPath(req)) res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })
  else res.status(status).json({ error: message })
}

export function createAgentServiceApp (opts: AgentServiceOptions): Express {
  const host = opts.host ?? '127.0.0.1'
  const loopbackBind = isLoopbackHost(host)
  const token = opts.token === undefined || opts.token === '' ? undefined : opts.token
  if (!loopbackBind && token === undefined) throw new Error(`MCP_TOKEN must be set to listen on ${host} (not a loopback address)`)
  if (token !== undefined && token.length < 16) throw new Error('MCP_TOKEN must be at least 16 characters')
  const log = opts.log ?? (() => {})
  const hostCheck = localhostHostValidation()

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  /** Runs the access rules for `agentId` (undefined: no agent, e.g. /health), then the SDK Host check for local access. */
  const guard = (agentOf: (req: Request) => string | undefined) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const agentId = agentOf(req)
    const decision = decideAccess({
      loopbackBind,
      forwarded: isForwarded(req),
      loopbackClient: isLoopbackAddress(req.socket.remoteAddress),
      origin: req.get('origin'),
      pathSecret: typeof req.params.secret === 'string' ? req.params.secret : undefined,
      bearer: bearerOf(req),
      agentSecret: agentId === undefined ? undefined : await opts.registry.tunnelSecret(agentId),
      token
    })
    if (!decision.ok) { reject(req, res, decision.status, decision.error); return }
    if (decision.via === 'local') hostCheck(req, res, next)
    else next()
  }

  app.get('/health', guard(() => undefined), (_req, res) => {
    res.json({ ok: true, pid: process.pid })
  })

  const agent = express.Router({ mergeParams: true })
  agent.use(guard(req => String(req.params.agentId)))
  agent.use(async (req, res, next) => {
    let runtime: AgentRuntime | undefined
    try {
      runtime = await opts.registry.get(String(req.params.agentId))
    } catch (err) {
      log(`[${String(req.params.agentId)}] could not load: ${err instanceof Error ? err.message : String(err)}`)
      reject(req, res, 500, 'the agent could not be loaded; see the service log')
      return
    }
    if (runtime === undefined) { reject(req, res, 404, 'no such agent on this machine'); return }
    res.locals.agent = runtime
    next()
  })

  agent.post('/mcp', (req, res) => {
    const runtime = res.locals.agent as AgentRuntime
    const server = runtime.setup.createServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void server.close() })
    server.connect(transport)
      .then(async () => { await transport.handleRequest(req, res, req.body) })
      .catch(err => {
        log(`[${runtime.agentId}] MCP request failed: ${err instanceof Error ? err.message : String(err)}`)
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
      })
  })
  // Stateless server: no SSE stream to resume, no session to delete.
  const notAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null })
  }
  agent.get('/mcp', notAllowed)
  agent.delete('/mcp', notAllowed)
  agent.use('/v1', createAgentApiRouter(log))
  agent.use((req, res) => { reject(req, res, 404, 'not found') })

  // The secret path first: /agents/<id>/s/<secret>/mcp would otherwise reach the plain route's guard without its secret.
  app.use('/agents/:agentId/s/:secret', agent)
  app.use('/agents/:agentId', agent)

  app.use((req: Request, res: Response) => { reject(req, res, 404, 'not found') })
  // Malformed JSON and other errors: a short answer, never the request URL.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500
    if (status >= 500) log(`request failed: ${err instanceof Error ? err.message : String(err)}`)
    if (!res.headersSent) reject(req, res, status, status === 400 ? 'invalid JSON body' : 'internal error')
  })
  return app
}
