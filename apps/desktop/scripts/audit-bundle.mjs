// Thin I/O wrapper around bundle-audit.mjs's pure rules: finds every
// app.asar electron-builder produced under dist/, lists its contents plus
// the rest of its resources/ directory (the unpacked sibling and any
// extraResources), and fails the build the moment any of them bundles an
// excluded SDK platform binary or is missing the positive control that
// proves the listing actually saw the packaged app. Every release asar's
// main-process JS is also scanned for fixture data.
//
// Direction: fails closed (docs/ENGINEERING.md §4, "An absent signal is
// never read as a passing one") — a listing that cannot be read, or that
// finds zero app.asar files, is a failure, never a pass.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import { appUpdateConfigGaps, asarArchivePath, auditEntries, fixtureLeaks, readSdkManifest, sdkPlatformPackages, updateMetadataGaps } from './bundle-audit.mjs'

const distDir = join(import.meta.dirname, '../dist')
const SMOKE_DIR = 'smoke'
const APP_UPDATE_FILE = 'app-update.yml'

/** The `[owner, repo]` the packaged app must update from, read from the same source as the config. */
function expectedRepository() {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, '../../../.claude/port.config.json'), 'utf8'))
  const [owner, repo] = String(config.repo ?? '').split('/')
  return { owner, repo }
}

/** The text of `resources/app-update.yml` inside an AppImage, or `undefined` when it cannot be extracted. */
function readAppImageUpdateConfig(appImagePath) {
  const scratch = mkdtempSync(join(tmpdir(), 'port-appimage-'))
  try {
    const result = spawnSync(appImagePath, ['--appimage-extract', `resources/${APP_UPDATE_FILE}`], { cwd: scratch, stdio: 'ignore' })
    if (result.status !== 0) return undefined
    const extracted = join(scratch, 'squashfs-root/resources', APP_UPDATE_FILE)
    return existsSync(extracted) ? readFileSync(extracted, 'utf8') : undefined
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

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

const expected = expectedRepository()
let failed = false
let scannedForFixtures = 0
let updateConfigsChecked = 0

function checkUpdateConfig(label, text) {
  updateConfigsChecked += 1
  for (const gap of appUpdateConfigGaps(text, expected)) {
    failed = true
    console.error(`bundle audit: FAIL — ${label}: ${gap}`)
  }
}

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

  // The `dist:smoke` copy legitimately carries fixtures, so only release asars are scanned.
  if (relative(distDir, asarPath).split(sep)[0] === SMOKE_DIR) continue

  const mainScripts = archiveEntries.filter((entry) => entry.startsWith('/out/main/') && entry.endsWith('.js'))
  if (mainScripts.length === 0) {
    failed = true
    console.error(`bundle audit: FAIL — ${asarPath} listing has no main-process JS to scan for fixture data`)
    continue
  }
  const files = mainScripts.map((entry) => ({ path: entry, text: extractFile(asarPath, asarArchivePath(entry, sep)).toString('utf8') }))
  for (const leak of fixtureLeaks(files)) {
    failed = true
    console.error(`bundle audit: FAIL — ${asarPath} carries fixture data in ${leak}`)
  }
  scannedForFixtures += 1

  const updateConfigPath = join(resourcesDir, APP_UPDATE_FILE)
  checkUpdateConfig(updateConfigPath, existsSync(updateConfigPath) ? readFileSync(updateConfigPath, 'utf8') : undefined)
}

const topLevelFiles = readdirSync(distDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)

for (const appImage of topLevelFiles.filter((name) => name.endsWith('.AppImage'))) {
  checkUpdateConfig(appImage, readAppImageUpdateConfig(join(distDir, appImage)))
}

const metadataGaps = updateMetadataGaps(topLevelFiles, (name) => readFileSync(join(distDir, name), 'utf8'))
for (const gap of metadataGaps) {
  failed = true
  console.error(`bundle audit: FAIL — update metadata: ${gap}`)
}

if (updateConfigsChecked === 0) {
  failed = true
  console.error(`bundle audit: FAIL — found no ${APP_UPDATE_FILE} to check`)
}

if (failed) process.exit(1)

const metadataCount = topLevelFiles.filter((name) => /^latest.*\.yml$/.test(name) || name.endsWith('.blockmap')).length

console.log(`bundle audit: ${asarFiles.length} app.asar checked, ${forbidden.length} SDK platform packages excluded, ${scannedForFixtures} scanned for fixture data, ${metadataCount} update metadata files, ${updateConfigsChecked} ${APP_UPDATE_FILE} checked`)
