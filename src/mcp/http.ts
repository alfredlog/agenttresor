/**
 * Streamable HTTP transport for the agent's MCP server (stateless: one MCP
 * server per request). Every request needs `Authorization: Bearer MCP_TOKEN`.
 * Bound to 127.0.0.1 by default, with the SDK's DNS-rebinding protection.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Express, NextFunction, Request, Response } from 'express'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export interface McpHttpOptions {
  createServer: () => McpServer
  token: string
  host?: string
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

export function createMcpHttpApp (opts: McpHttpOptions): Express {
  if (opts.token.length < 16) throw new Error('MCP_TOKEN must be at least 16 characters')
  const expected = sha256(opts.token)
  const app = createMcpExpressApp({ host: opts.host ?? '127.0.0.1' })

  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')
    // Compare fixed-length hashes so timingSafeEqual never sees different lengths.
    if (m === null || !timingSafeEqual(sha256(m[1]), expected)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'missing or invalid MCP token' }, id: null })
      return
    }
    next()
  })

  app.post('/mcp', (req: Request, res: Response) => {
    const server = opts.createServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void server.close() })
    server.connect(transport)
      .then(async () => { await transport.handleRequest(req, res, req.body) })
      .catch(err => {
        console.error('MCP request failed:', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
      })
  })

  // Stateless server: no SSE stream to resume, no session to delete.
  const notAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null })
  }
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
  return app
}
