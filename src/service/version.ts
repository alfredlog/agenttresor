/**
 * The version of the agent service's code: the package version and the git
 * commit of the checkout. The service reads it once at start and reports it on
 * GET /health; setup and doctor compare it with the code on disk, so a service
 * still running old code after `git pull` is restarted.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CodeVersion {
  /** package.json "version". */
  package: string
  /** The checked-out commit, or 'unknown' outside a git checkout. */
  commit: string
  /** `<package>+<commit>`: what is compared. */
  id: string
}

export async function readCodeVersion (projectRoot: string): Promise<CodeVersion> {
  let pkg = 'unknown'
  try {
    pkg = String((JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { version?: unknown }).version ?? 'unknown')
  } catch {}
  let commit = 'unknown'
  try {
    commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, timeout: 5_000 })).stdout.trim() || 'unknown'
  } catch {}
  return { package: pkg, commit, id: `${pkg}+${commit}` }
}
