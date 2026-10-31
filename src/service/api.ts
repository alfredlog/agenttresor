/**
 * Plain HTTP API for agents that do not speak MCP, mounted per agent at
 * /agents/<agentId>/v1 (same access rules as /mcp). The answers are the same
 * JSON results as the MCP tools, without the sentence in front:
 *
 *   GET  /v1/budget                 check_budget
 *   POST /v1/price                  get_price      { url, method?, body? }
 *   POST /v1/pay                    pay_and_fetch  { url, method?, body?, purpose, maxSats }
 *   GET  /v1/requests/:requestId    check_request  (pays an approved request)
 *
 * Status codes: 200 with the result (its `status` says paid, pending, denied…),
 * 400 for invalid input, 502 when the proxy cannot answer, 503 when the agent
 * is not connected.
 */
import express, { type Request, type Response, type Router } from 'express'
import { z } from 'zod'
import { payShape, requestIdShape, requestShape, type ToolOutcome } from '../agent/tools.js'
import type { AgentRuntime } from './registry.js'

const priceInput = z.object(requestShape)
const payInput = z.object(payShape)
const requestIdInput = z.object(requestIdShape)

function send (res: Response, o: ToolOutcome): void {
  const runtime = res.locals.agent as AgentRuntime
  if (o.unavailable === true) {
    res.status(runtime.setup.disconnected !== undefined ? 503 : 502).json({ error: o.summary })
    return
  }
  res.json(o.data ?? { message: o.summary })
}

function invalid (res: Response, err: z.ZodError): void {
  res.status(400).json({ error: 'invalid input', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) })
}

export function createAgentApiRouter (log: (msg: string) => void): Router {
  const api = express.Router({ mergeParams: true })
  const tools = (res: Response): AgentRuntime['setup']['tools'] => (res.locals.agent as AgentRuntime).setup.tools
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response): void => {
    fn(req, res).catch(err => {
      log(`[${(res.locals.agent as AgentRuntime).agentId}] API request failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.status(500).json({ error: 'internal error' })
    })
  }

  api.get('/budget', wrap(async (_req, res) => { send(res, await tools(res).checkBudget()) }))

  api.post('/price', wrap(async (req, res) => {
    const input = priceInput.safeParse(req.body ?? {})
    if (!input.success) { invalid(res, input.error); return }
    send(res, await tools(res).getPrice(input.data))
  }))

  api.post('/pay', wrap(async (req, res) => {
    const input = payInput.safeParse(req.body ?? {})
    if (!input.success) { invalid(res, input.error); return }
    send(res, await tools(res).payAndFetch(input.data))
  }))

  api.get('/requests/:requestId', wrap(async (req, res) => {
    const input = requestIdInput.safeParse({ requestId: req.params.requestId })
    if (!input.success) { invalid(res, input.error); return }
    send(res, await tools(res).checkRequest(input.data.requestId))
  }))

  return api
}
