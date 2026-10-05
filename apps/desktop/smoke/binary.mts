// Resolves the packaged executable electron-builder leaves under `apps/desktop/dist/` — one path per OS, matching `electron-builder.config.mjs`'s own `executableName`/`productName`.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(HERE, '..', 'dist')

function candidatePaths(): readonly string[] {
  switch (process.platform) {
    case 'linux':
      return [join(DIST_DIR, 'linux-unpacked', 'port-desktop')]
    case 'win32':
      return [join(DIST_DIR, 'win-unpacked', 'port.exe')]
    case 'darwin':
      // arm64 output dir is `mac-arm64`; x64 is `mac` — the fallback covers both.
      return [join(DIST_DIR, 'mac-arm64', 'port.app', 'Contents', 'MacOS', 'port'), join(DIST_DIR, 'mac', 'port.app', 'Contents', 'MacOS', 'port')]
    default:
      throw new Error(`packagedExecutable: unsupported platform '${process.platform}'`)
  }
}

/** Fails fast with the actual remedy rather than a Playwright launch error an agent would have to decode. */
export function packagedExecutable(): string {
  const candidates = candidatePaths()
  const found = candidates.find((path) => existsSync(path))
  if (found) return found

  throw new Error(`Packaged app not found at ${candidates.join(' or ')}. Run \`pnpm --filter @port/desktop dist\` first.`)
}
