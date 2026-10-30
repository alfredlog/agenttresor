/**
 * Opt-in public tunnel for ChatGPT: a Cloudflare quick tunnel
 * (`cloudflared tunnel --url http://127.0.0.1:<port>`) in front of the local
 * service. The whole port is reachable through it, but every request that
 * comes through it needs an agent's secret (access.ts), so only the agent
 * whose capability URL was handed out can be used.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'

export const CLOUDFLARED_INSTALL = 'cloudflared is not installed. Install it with:  brew install cloudflared\n' +
  '(other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)'

export function cloudflaredInstalled (bin = 'cloudflared'): boolean {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' })
  return r.error === undefined && r.status === 0
}

/** The one URL to paste into ChatGPT. It is a capability: whoever has it can use this agent (within the company's rules). */
export function capabilityUrl (publicBase: string, agentId: string, secret: string): string {
  return `${publicBase.replace(/\/+$/, '')}/agents/${encodeURIComponent(agentId)}/s/${secret}/mcp`
}

const TRYCLOUDFLARE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/

export interface OpenTunnel {
  publicBase: string
  process: ChildProcess
}

/**
 * Starts cloudflared and resolves with the tunnel's public https URL once it
 * prints it. cloudflared's own output goes to `logFile` (it never sees a secret).
 */
export async function openTunnel (port: number, logFile: string, bin = 'cloudflared', timeoutMs = 60_000): Promise<OpenTunnel> {
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
  return await new Promise((resolve, reject) => {
    let seen = ''
    let found = false
    const timer = setTimeout(() => { child.kill(); reject(new Error(`cloudflared printed no tunnel URL within ${timeoutMs / 1000} s; see ${logFile}`)) }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      log.write(chunk)
      if (found) return
      seen = (seen + chunk.toString('utf8')).slice(-4096)
      const m = TRYCLOUDFLARE.exec(seen)
      if (m !== null) {
        found = true
        clearTimeout(timer)
        resolve({ publicBase: m[0], process: child })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', err => { clearTimeout(timer); reject(err) })
    child.once('exit', code => { clearTimeout(timer); log.end(); reject(new Error(`cloudflared exited (${String(code)}); see ${logFile}`)) })
  })
}
