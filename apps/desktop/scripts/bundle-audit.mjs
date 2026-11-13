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

/** The `WIDGETS_ID` literal in `tests/fixtures/app/repos.ts` — present in every bundle that carries fixture data. */
export const FIXTURE_SENTINEL = 'fixture-acme-widgets'

/** The paths whose text contains fixture data. */
export function fixtureLeaks(files) {
  return files.filter((file) => file.text.includes(FIXTURE_SENTINEL)).map((file) => file.path)
}

/** The unrooted, `separator`-joined path `extractFile` needs, because `@electron/asar` splits it on `path.sep`. */
export function asarArchivePath(entry, separator) {
  return entry.replace(/^\//, '').split('/').join(separator)
}

/** The update metadata each installer type ships beside it. AppImage embeds its blockmap; `.deb` is unmapped. */
export const UPDATE_METADATA = {
  '.exe': { yml: 'latest.yml', blockmap: true },
  '.dmg': { yml: 'latest-mac.yml', blockmap: true },
  '.AppImage': { yml: 'latest-linux.yml', blockmap: false },
}

function installerExtension(fileName) {
  return Object.keys(UPDATE_METADATA).find((ext) => fileName.endsWith(ext))
}

/** One message per gap in the update metadata beside the installers, given the top-level `dist/`
 *  basenames. An empty listing is a gap, never a pass. */
export function updateMetadataGaps(fileNames, readText) {
  const installers = fileNames.filter((name) => installerExtension(name) !== undefined)
  if (installers.length === 0) return ['no installer with update metadata found in dist/']

  const present = new Set(fileNames)
  const gaps = []
  for (const installer of installers) {
    const { yml, blockmap } = UPDATE_METADATA[installerExtension(installer)]
    if (!present.has(yml)) {
      gaps.push(`${yml} is missing for ${installer}`)
    } else if (!readText(yml).split(/\r?\n/).some((line) => line.trim() === `- url: ${installer}` || line.trim() === `url: ${installer}`)) {
      gaps.push(`${yml} does not name ${installer}`)
    }
    if (blockmap && !present.has(`${installer}.blockmap`)) gaps.push(`${installer}.blockmap is missing`)
  }
  return gaps
}

/** Gaps in a packaged `app-update.yml` against the repository the updater must read from. */
export function appUpdateConfigGaps(text, { owner, repo }) {
  if (!text || text.trim() === '') return ['app-update.yml is absent or empty']
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const gaps = []
  if (!lines.includes('provider: github')) gaps.push('app-update.yml has no `provider: github` line')
  if (!lines.includes(`owner: ${owner}`)) gaps.push(`app-update.yml has no \`owner: ${owner}\` line`)
  if (!lines.includes(`repo: ${repo}`)) gaps.push(`app-update.yml has no \`repo: ${repo}\` line`)
  return gaps
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
