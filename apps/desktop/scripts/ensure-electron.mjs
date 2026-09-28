// A pnpm store relink can recreate the `electron` package directory with its
// `path.txt` intact but its `dist/` binary gone —
// `electron-vite`'s own bundled `getElectronPath` trusts `path.txt`
// unconditionally and never checks the binary still exists, so `pnpm dev`
// crashes mid-launch with `Electron uninstall` instead of a clear message.
//
// Requiring the `electron` package here runs its own `index.js`, which does
// check that `dist/<binary>` still exists and re-runs its bundled installer
// to re-download it when it does not — the self-heal `electron-vite` skips.
// Chained ahead of `electron-vite dev` in `package.json`'s `dev` script
// (not a `predev` lifecycle hook, since pnpm's `enable-pre-post-scripts`
// behaviour isn't guaranteed across versions/config), so a broken
// environment fails loudly here before `electron-vite` starts.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

try {
  require('electron')
} catch (error) {
  console.error('[ensure-electron] failed to verify the electron binary', error)
  process.exit(1)
}
