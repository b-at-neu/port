// Pure audit rules for #335's bundle exclusion assertion, plus the one SDK
// manifest read `electron-builder.config.mjs` and `audit-bundle.mjs` both
// need. Imports only `node:` builtins so `scripts/checks/desktop-packaging.ts`
// (layer 1) can import this module with no `node_modules` installed.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The SDK's own `package.json`, read off disk beside its resolved entry
 *  point — the package's `exports` map has no `./package.json` condition, so
 *  it cannot be resolved directly. */
export function readSdkManifest() {
  const require = createRequire(import.meta.url)
  const entry = require.resolve(SDK_PACKAGE)
  const manifestPath = join(dirname(entry), 'package.json')
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/** The per-platform binary packages the SDK ships as `optionalDependencies` —
 *  today the eight `claude-agent-sdk-<os>-<arch>[-musl]` packages. Never
 *  listed by hand: the SDK's own manifest is the one source of truth. */
export function sdkPlatformPackages(manifest) {
  return Object.keys(manifest.optionalDependencies ?? {})
}

/** The required positive control: paths that must be present for the
 *  listing to have actually seen the packaged app, rather than an empty or
 *  truncated one passing vacuously. */
const REQUIRED_ENTRIES = ['/out/main/index.js', `/node_modules/${SDK_PACKAGE}/sdk.mjs`]

/** Classifies a forward-slashed, `/`-rooted asar listing against the
 *  `forbidden` SDK platform packages. Returns `{ bundled, missing }`:
 *  `bundled` is every entry that should have been excluded, `missing` is
 *  every required positive-control path that never showed up. */
export function auditEntries(entries, forbidden) {
  const bundled = entries.filter((entry) => {
    if (forbidden.some((pkg) => entry.startsWith(`/node_modules/${pkg}/`))) return true
    const basename = entry.slice(entry.lastIndexOf('/') + 1)
    return basename === 'claude' || basename === 'claude.exe'
  })

  const present = new Set(entries)
  const missing = REQUIRED_ENTRIES.filter((required) => !present.has(required))

  return { bundled, missing }
}
