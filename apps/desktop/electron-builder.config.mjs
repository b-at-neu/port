// electron-builder packages the existing electron-vite build output (out/)
// as AppImage + deb (Linux), dmg (macOS) and NSIS (Windows). The SDK's own
// bundled per-platform Claude binaries are excluded via file glob negations
// derived from the SDK's own manifest — never listed by hand, so a new SDK
// release that adds a platform package is excluded automatically rather
// than silently bundled (apps/desktop/scripts/bundle-audit.mjs).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSdkManifest, sdkPlatformPackages } from './scripts/bundle-audit.mjs'

const root = join(import.meta.dirname, '../..')

/** Reads the release version from the one place the rest of the repository
 *  already treats as authoritative (`.claude/port.config.json` →
 *  `release.versionFiles[0]`), never `apps/desktop/package.json`'s own
 *  unbumped `0.0.0`. Throws a named error at every link that could be
 *  missing rather than falling back to a default. */
function readVersion() {
  const configPath = join(root, '.claude/port.config.json')
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`electron-builder.config.mjs: could not read ${configPath}: ${error.message}`, { cause: error })
  }

  const versionFile = config?.release?.versionFiles?.[0]
  if (!versionFile) {
    throw new Error(`electron-builder.config.mjs: ${configPath} has no release.versionFiles[0]`)
  }

  const versionFilePath = join(root, versionFile)
  let versionManifest
  try {
    versionManifest = JSON.parse(readFileSync(versionFilePath, 'utf8'))
  } catch (error) {
    throw new Error(`electron-builder.config.mjs: could not read ${versionFilePath}: ${error.message}`, { cause: error })
  }

  if (!versionManifest.version) {
    throw new Error(`electron-builder.config.mjs: ${versionFilePath} has no 'version' field`)
  }

  return versionManifest.version
}

const version = readVersion()
const forbidden = sdkPlatformPackages(readSdkManifest())

const author = {
  name: 'port',
  email: '144247685+b-at-neu@users.noreply.github.com',
}

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'io.github.b-at-neu.port',
  productName: 'port',
  extraMetadata: {
    name: 'port-desktop',
    productName: 'port',
    version,
    author,
    homepage: 'https://github.com/b-at-neu/port',
  },
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  // out/**/* plus one negation per SDK platform package — the app always
  // runs the user's own installed `claude`, never a bundled one.
  files: ['out/**/*', ...forbidden.map((pkg) => `!**/node_modules/${pkg}{,/**}`)],
  asar: true,
  npmRebuild: false,
  extraResources: [{ from: 'NOTICE.txt', to: 'NOTICE.txt' }],
  linux: {
    target: ['AppImage', 'deb'],
    executableName: 'port-desktop',
    category: 'Development',
    icon: 'build/icon.png',
    maintainer: `${author.name} <${author.email}>`,
  },
  mac: {
    target: 'dmg',
    icon: 'build/icon.png',
    // Ad-hoc signing so the arm64 build launches at all — an unsigned arm64
    // binary is otherwise killed at launch. No notarization; unsigned,
    // unreleased builds only (apps/desktop/README.md covers the warning).
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
  },
  win: {
    // No signing config. NSIS stays one-click (electron-builder's default).
    target: 'nsis',
    icon: 'build/icon.png',
  },
  artifactName: 'port-${version}-${os}-${arch}.${ext}',
}
