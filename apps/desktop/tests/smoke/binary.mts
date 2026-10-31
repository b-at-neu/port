// Resolves the packaged executable electron-builder leaves under `apps/desktop/dist/` — one path per OS, matching `electron-builder.config.mjs`'s own `executableName`/`productName`.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(HERE, '..', '..', 'dist')
export const SMOKE_DIST_DIR = join(DIST_DIR, 'smoke')

function candidatePaths(distDir: string): readonly string[] {
  switch (process.platform) {
    case 'linux':
      return [join(distDir, 'linux-unpacked', 'port-desktop')]
    case 'win32':
      return [join(distDir, 'win-unpacked', 'port.exe')]
    case 'darwin':
      // arm64 output dir is `mac-arm64`; x64 is `mac` — the fallback covers both.
      return [join(distDir, 'mac-arm64', 'port.app', 'Contents', 'MacOS', 'port'), join(distDir, 'mac', 'port.app', 'Contents', 'MacOS', 'port')]
    default:
      throw new Error(`packagedExecutable: unsupported platform '${process.platform}'`)
  }
}

/** Fails fast with the actual remedy rather than a Playwright launch error an agent would have to decode. */
export function packagedExecutable(distDir: string = DIST_DIR): string {
  const candidates = candidatePaths(distDir)
  const found = candidates.find((path) => existsSync(path))
  if (found) return found

  const remedy = distDir === SMOKE_DIST_DIR ? 'pnpm --filter @port/desktop dist:smoke' : 'pnpm --filter @port/desktop dist'
  throw new Error(`Packaged app not found at ${candidates.join(' or ')}. Run \`${remedy}\` first.`)
}
