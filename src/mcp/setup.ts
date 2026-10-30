/**
 * Starts the agent side for the MCP server: settings from
 * mcp-data/agent-config.json (env vars override), the agent's own key, and the
 * key registration with the proxy. When the agent is not connected, or its key
 * was revoked, the server still starts and every tool says what to do.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resolveAgentSettings, type AgentSettings } from '../agent/config.js'
import { AgentKeyError, loadOrCreateAgentKey, registerAgentKey } from '../agent/keys.js'
import { AgentPayer } from '../agent/pay.js'
import { ProxyClient } from '../agent/proxy-client.js'
import { fingerprint } from '../shared/fingerprint.js'
import { createAgentMcpServer, NOT_CONNECTED } from './server.js'

export interface AgentSetup {
  createServer: () => McpServer
  /** Undefined when connected; otherwise what every tool answers. */
  disconnected?: string
}

export async function setupAgent (dataDir: string, env: NodeJS.ProcessEnv, log: (msg: string) => void = () => {}): Promise<AgentSetup> {
  const offline = (message: string): AgentSetup => {
    log(message)
    return { createServer: () => createAgentMcpServer({ disconnected: message }), disconnected: message }
  }

  let settings: AgentSettings | undefined
  try {
    settings = await resolveAgentSettings(dataDir, env)
  } catch (err) {
    return offline(`${NOT_CONNECTED} (${err instanceof Error ? err.message : String(err)})`)
  }
  if (settings === undefined) return offline(NOT_CONNECTED)

  const client = new ProxyClient({ proxyUrl: settings.proxyUrl, apiKey: settings.apiKey })
  const agentKey = await loadOrCreateAgentKey(dataDir)
  log(`${agentKey.created ? 'created' : 'loaded'} agent key ${agentKey.publicKey.slice(0, 16)}… (${agentKey.path})`)
  // stderr only: on stdio, stdout belongs to the MCP protocol. The company checks this before funding.
  log(`Agent key fingerprint: ${fingerprint(agentKey.publicKey)}`)

  try {
    const registration = await registerAgentKey(client, agentKey.publicKey)
    log(registration === 'registered' ? `connected to ${settings.proxyUrl}; agent key registered` : `connected to ${settings.proxyUrl}; vault open with this agent key`)
  } catch (err) {
    if (err instanceof AgentKeyError && err.status === 401) {
      return offline(`${NOT_CONNECTED} (the proxy no longer accepts this agent's API key: it was revoked when a new code was issued)`)
    }
    if (err instanceof AgentKeyError) return offline(`Not usable: ${err.message}`)
    // A network problem at start: keep going, the tools will report errors until the proxy is reachable.
    log(`could not reach the proxy to register the agent key: ${err instanceof Error ? err.message : String(err)}`)
  }

  const payer = new AgentPayer({ client, key: agentKey.key })
  return { createServer: () => createAgentMcpServer({ payer, client, merchantUrls: settings.merchantUrls, agentPublicKey: agentKey.publicKey }) }
}
