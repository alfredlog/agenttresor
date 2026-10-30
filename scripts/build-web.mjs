/**
 * Bundles the vault page script for the browser: `npm run build:web` → public/vault.js.
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
    b.onResolve({ filter: /\/shared\/bsv\.js$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/bsv\.js$/, 'bsv.browser.ts')) }))
  }
}

await build({
  entryPoints: [resolve(root, 'src/company/vault-page.ts')],
  outfile: resolve(root, 'public/vault.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  plugins: [browserSdk],
  logLevel: 'info'
})
