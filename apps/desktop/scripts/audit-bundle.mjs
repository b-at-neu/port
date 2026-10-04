// Thin I/O wrapper around bundle-audit.mjs's pure rules: finds every
// app.asar electron-builder produced under dist/, lists its contents plus
// the rest of its resources/ directory (the unpacked sibling and any
// extraResources), and fails the build the moment any of them bundles an
// excluded SDK platform binary or is missing the positive control that
// proves the listing actually saw the packaged app.
//
// Direction: fails closed (docs/ENGINEERING.md §4, "An absent signal is
// never read as a passing one") — a listing that cannot be read, or that
// finds zero app.asar files, is a failure, never a pass.
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { listPackage } from '@electron/asar'
import { auditEntries, readSdkManifest, sdkPlatformPackages } from './bundle-audit.mjs'

const distDir = join(import.meta.dirname, '../dist')

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

/** `relPath` rooted at `/` with every path separator forward-slashed, so a
 *  Windows-built listing compares identically to the POSIX-built one. */
function toPosixRooted(relPath) {
  return `/${relPath.split(sep).join('/')}`
}

const asarFiles = walk(distDir).filter((f) => basename(f) === 'app.asar')

if (asarFiles.length === 0) {
  console.error('bundle audit: FAIL — found no app.asar under dist/')
  process.exit(1)
}

const forbidden = sdkPlatformPackages(readSdkManifest())

if (forbidden.length === 0) {
  console.error('bundle audit: FAIL — the SDK manifest names no optionalDependencies; the exclusion would pass vacuously')
  process.exit(1)
}

let failed = false

for (const asarPath of asarFiles) {
  const resourcesDir = dirname(asarPath)

  const archiveEntries = listPackage(asarPath, { isPack: false }).map((p) => p.split('\\').join('/'))

  // Everything else in the same resources/ directory — the app.asar.unpacked
  // sibling and any extraResources — none of which live inside the archive
  // itself, so they are invisible to listPackage.
  const resourceEntries = walk(resourcesDir)
    .filter((f) => f !== asarPath)
    .map((f) => toPosixRooted(relative(resourcesDir, f)))

  const { bundled, missing } = auditEntries([...archiveEntries, ...resourceEntries], forbidden)

  if (bundled.length > 0) {
    failed = true
    for (const entry of bundled) console.error(`bundle audit: FAIL — ${asarPath} bundles excluded path: ${entry}`)
  }
  if (missing.length > 0) {
    failed = true
    for (const entry of missing) console.error(`bundle audit: FAIL — ${asarPath} listing is missing required path: ${entry}`)
  }
}

if (failed) process.exit(1)

console.log(`bundle audit: ${asarFiles.length} app.asar checked, ${forbidden.length} SDK platform packages excluded`)
