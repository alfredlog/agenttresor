/**
 * Starts one agent: settings from its profile's agent-config.json (env vars
 * override, for the single-agent stdio server only), the profile's own key,
 * and the key registration with the proxy. When the agent is not connected, or
 * its key was revoked, it still starts and every tool says what to do.
 */
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resolveAgentSettings, type AgentSettings } from '../agent/config.js'
import { AgentKeyError, loadOrCreateAgentKey, registerAgentKey } from '../agent/keys.js'
import { openAgentTokenWallet } from '../agent/token-wallet.js'
import { AgentPayer } from '../agent/pay.js'
import { ProxyClient } from '../agent/proxy-client.js'
import { OverlayClient } from '../token/overlayApi.js'
import { TokenKit } from '../token/token.js'
import { fingerprint } from '../shared/fingerprint.js'
import { createAgentTools, type AgentTools } from '../agent/tools.js'
import { createAgentMcpServer, NOT_CONNECTED } from './server.js'

export interface AgentSetup {
  createServer: () => McpServer
  /** The same tools, for the plain HTTP API. */
  tools: AgentTools
  /** The agent's public key fingerprint, once its key exists. */
  fingerprint?: string
  /** Undefined when connected; otherwise what every tool answers. */
  disconnected?: string
  /** Closes the local token wallet, if it was opened. */
  close?: () => Promise<void>
}

/** `dataDir` is the agent's profile directory (agent-config.json and agent-key.json). */
export async function setupAgent (dataDir: string, env: NodeJS.ProcessEnv, log: (msg: string) => void = () => {}): Promise<AgentSetup> {
  let fp: string | undefined
  const offline = (message: string): AgentSetup => {
    log(message)
    return { createServer: () => createAgentMcpServer({ disconnected: message }), tools: createAgentTools({ disconnected: message }), fingerprint: fp, disconnected: message }
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
  fp = fingerprint(agentKey.publicKey)
  log(`Agent key fingerprint: ${fp}`)

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

  const tokenOverlayUrl = env.BSV21_OVERLAY_URL?.trim() ?? ''
  const tokenId = env.BSV21_TOKEN_ID?.trim() ?? ''
  const companyIdentityKey = env.BSV21_COMPANY_IDENTITY_KEY?.trim() ?? ''
  let tokenKit: TokenKit | undefined
  let closeTokenWallet: (() => Promise<void>) | undefined

  if ((tokenOverlayUrl === '') !== (tokenId === '')) {
    log('BSV-21 is disabled: set both BSV21_OVERLAY_URL and BSV21_TOKEN_ID')
  } else if (tokenOverlayUrl !== '' && tokenId !== '') {
    try {
      const tokenWallet = await openAgentTokenWallet(
        agentKey.key,
        join(dataDir, 'agent-token-wallet.sqlite')
      )
      tokenKit = new TokenKit(tokenWallet.wallet, new OverlayClient(tokenOverlayUrl))
      closeTokenWallet = tokenWallet.close
      log(`BSV-21 enabled for token ${tokenId}`)
    } catch (err) {
      log(`BSV-21 wallet could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log('BSV-21 is not configured for this agent')
  }

  const options = {
    payer,
    client,
    merchantUrls: settings.merchantUrls,
    agentPublicKey: agentKey.publicKey,
    ...(tokenKit !== undefined ? { tokenKit } : {}),
    ...(tokenId !== '' ? { tokenId } : {}),
    ...(companyIdentityKey !== '' ? { companyIdentityKey } : {})
  }

  return {
    createServer: () => createAgentMcpServer(options),
    tools: createAgentTools(options),
    fingerprint: fp,
    ...(closeTokenWallet !== undefined ? { close: closeTokenWallet } : {})
  }
}