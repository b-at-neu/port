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

const portConfigPath = join(root, '.claude/port.config.json')

function readPortConfig() {
  try {
    return JSON.parse(readFileSync(portConfigPath, 'utf8'))
  } catch (error) {
    throw new Error(`electron-builder.config.mjs: could not read ${portConfigPath}: ${error.message}`, { cause: error })
  }
}

/** The `[owner, repo]` the update metadata points at, from `repo` in
 *  `.claude/port.config.json`. */
function readRepository(config) {
  const parts = typeof config?.repo === 'string' ? config.repo.split('/') : []
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`electron-builder.config.mjs: ${portConfigPath} has no 'repo' of the form owner/name`)
  }
  return parts
}

/** Reads the release version from the one place the rest of the repository
 *  already treats as authoritative (`.claude/port.config.json` →
 *  `release.versionFiles[0]`). Throws a named error at every link that
 *  could be missing rather than falling back to a default. */
function readVersion(config) {
  const versionFile = config?.release?.versionFiles?.[0]
  if (!versionFile) {
    throw new Error(`electron-builder.config.mjs: ${portConfigPath} has no release.versionFiles[0]`)
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

const portConfig = readPortConfig()
const version = readVersion(portConfig)
const [owner, repo] = readRepository(portConfig)
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
  // Makes `dist` emit the latest*.yml update metadata and bake app-update.yml into the app.
  // Nothing is published from here: `dist` passes --publish never and the release workflow uploads.
  publish: { provider: 'github', owner, repo },
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  // out/**/* plus one negation per SDK platform package — the app always
  // runs the user's own installed `claude`, never a bundled one.
  files: ['out/**/*', ...forbidden.map((pkg) => `!**/node_modules/${pkg}{,/**}`)],
  asar: true,
  npmRebuild: false,
  extraResources: [
    { from: 'NOTICE.txt', to: 'NOTICE.txt' },
    // A packaged Linux window reads its own icon from here at runtime — electron-builder's
    // derived .desktop/exe icons never set the X11/Wayland window icon.
    { from: 'build/icon.png', to: 'icon.png' },
    // A stage session's `claude` process reads these from disk, so they can't live inside the asar.
    { from: 'stage-prompts', to: 'stage-prompts' },
  ],
  linux: {
    target: ['AppImage', 'deb'],
    executableName: 'port-desktop',
    category: 'Development',
    // Per-size PNGs (scripts/icon.mjs) — hicolor only declares up to 512x512,
    // so the flat 1024px build/icon.png would land in a dir it never scans.
    icon: 'build/icons',
    maintainer: `${author.name} <${author.email}>`,
    // Matches the installed `.desktop` filename to `desktopName` (package.json), which doubles
    // as Electron's runtime app_id/WM_CLASS — otherwise desktop environments can't find the icon.
    syncDesktopName: true,
  },
  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.png',
    // Ad-hoc signed only: Apple Silicon kills an unsigned binary at launch; no notarization.
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
