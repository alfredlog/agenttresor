/**
 * Settings shared by the service and its commands: the project's .env, then
 * MCP_DATA_DIR (default mcp-data, relative to the project), MCP_PORT (5070),
 * MCP_HOST (127.0.0.1) and MCP_TOKEN (required only off loopback).
 */
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { DEFAULT_PORT } from './control.js'

// launchd and MCP clients start us from unrelated working directories, so paths resolve against the project.
export const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

export interface ServiceEnv {
  projectRoot: string
  dataDir: string
  port: number
  host: string
  token?: string
}

export function loadEnv (env: NodeJS.ProcessEnv = process.env): ServiceEnv {
  dotenv.config({ path: join(projectRoot, '.env'), quiet: true })
  // An empty line in .env (MCP_HOST=) means the default.
  const set = (v: string | undefined): string | undefined => v === undefined || v.trim() === '' ? undefined : v.trim()
  const dataDirEnv = set(env.MCP_DATA_DIR) ?? 'mcp-data'
  const port = Number(set(env.MCP_PORT) ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`MCP_PORT is not a port: ${String(env.MCP_PORT)}`)
  return {
    projectRoot,
    dataDir: isAbsolute(dataDirEnv) ? dataDirEnv : join(projectRoot, dataDirEnv),
    port,
    host: set(env.MCP_HOST) ?? '127.0.0.1',
    token: set(env.MCP_TOKEN)
  }
}

/** The local base URL MCP clients use (always loopback, even when MCP_HOST is wider). */
export const localBase = (port: number): string => `http://127.0.0.1:${port}`
/** One agent's own MCP address; clients use the active agent's /mcp instead (client-config.ts). */
export const mcpUrl = (port: number, agentId: string): string => `${localBase(port)}/agents/${agentId}/mcp`
/** The local agent panel (panel.ts): switch agents, see the doctor checks. */
export const panelUrl = (port: number): string => `${localBase(port)}/`
