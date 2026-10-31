/**
 * Bundles the browser scripts: `npm run build:web` →
 *   public/vault.js        the vault page (fund, approve, reclaim from BSV Desktop)
 *   public/fingerprint.js  the agent key fingerprint, for the dashboard
 *   public/setup-command.js  the setup command shown for a connection link (dashboard, connect page)
 *   public/rules-form.js     the rules form (sats or euros) and the BSV/EUR line, for the dashboard
 *   public/audit.js        "Anchor now" and "Top up notary" with BSV Desktop on the dashboard (loaded on demand)
 * src/shared/bsv.ts loads the SDK with createRequire (Node only); in the bundle
 * it is replaced by src/shared/bsv.browser.ts, which re-exports the ESM build.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const browserSdk = {
  name: 'browser-sdk',
  setup (b) {
    // '../shared/bsv.js' from other folders, './bsv.js' from src/shared itself.
    b.onResolve({ filter: /(^|\/)bsv\.js$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/bsv\.js$/, 'bsv.browser.ts')) }))
  }
}

await build({
  entryPoints: {
    vault: resolve(root, 'src/company/vault-page.ts'),
    fingerprint: resolve(root, 'src/shared/fingerprint.ts'),
    'setup-command': resolve(root, 'src/shared/setup-command.ts'),
    'rules-form': resolve(root, 'src/shared/rules-form.ts'),
    audit: resolve(root, 'src/company/audit-page.ts')
  },
  outdir: resolve(root, 'public'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  plugins: [browserSdk],
  logLevel: 'info'
})
