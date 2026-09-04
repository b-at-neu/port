import { access as fsAccess, constants } from 'node:fs/promises'
import { posix as posixImpl, win32 as win32Impl } from 'node:path'

export interface WhichEnv {
  readonly PATH?: string
  readonly PATHEXT?: string
  readonly [key: string]: string | undefined
}

export type WhichPlatform = 'darwin' | 'linux' | 'win32'

export interface WhichOptions {
  readonly command: string
  readonly env: WhichEnv
  readonly platform: NodeJS.Platform
  /** Injectable existence/executable probe — real filesystem access by
   *  default, a stub in tests so no binary needs to actually be installed. */
  readonly probe?: (candidate: string) => Promise<boolean>
}

export type WhichResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'not-found'; readonly command: string; readonly searched: readonly string[] }

/** The macOS-launched-from-Finder case: a GUI process inherits no login-shell
 *  `PATH`, so Homebrew and the standard prefixes need a fallback. Windows
 *  ships neither by default, so the CLIs' own installer locations stand in. A
 *  login shell is never spawned to harvest `PATH` — that is exactly the
 *  POSIX-only shell-out this layer forbids. */
const FALLBACK_DIRS: Readonly<Record<WhichPlatform, readonly string[]>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'],
  linux: ['/usr/local/bin', '/usr/bin'],
  win32: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', 'C:\\Program Files\\GitHub CLI'],
}

function normalizePlatform(platform: NodeJS.Platform): WhichPlatform {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'darwin'
  return 'linux'
}

/** The target platform's own `path.join`/`delimiter` — never the host's.
 *  `which` is exercised against a simulated `win32` from a Linux test host
 *  (and vice versa), so joining candidate paths with the host's separator
 *  would silently mangle them. */
function pathImplFor(platform: WhichPlatform) {
  return platform === 'win32' ? win32Impl : posixImpl
}

function delimiterFor(platform: WhichPlatform): string {
  return platform === 'win32' ? ';' : ':'
}

function overrideEnvName(command: string): string {
  return `PORT_${command.toUpperCase()}_PATH`
}

function candidateNames(command: string, platform: WhichPlatform, env: WhichEnv): readonly string[] {
  if (platform !== 'win32') return [command]
  const pathext = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const exts = pathext.split(';').filter((ext) => ext !== '')
  return exts.map((ext) => `${command}${ext.toLowerCase()}`)
}

async function defaultProbe(candidate: string): Promise<boolean> {
  try {
    await fsAccess(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `which` is cached per instance — `createWhich()` gives tests a fresh,
 * isolated cache, while the default export below is the one process-lifetime
 * instance every adapter shares.
 */
export function createWhich(): { which: (options: WhichOptions) => Promise<WhichResult> } {
  const cache = new Map<string, string>()

  async function which(options: WhichOptions): Promise<WhichResult> {
    const platform = normalizePlatform(options.platform)
    const cacheKey = `${platform}:${options.command}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return { ok: true, path: cached }

    const probe = options.probe ?? defaultProbe
    const searched: string[] = []

    const override = options.env[overrideEnvName(options.command)]
    if (override !== undefined && override !== '') {
      searched.push(override)
      if (await probe(override)) {
        cache.set(cacheKey, override)
        return { ok: true, path: override }
      }
    }

    const names = candidateNames(options.command, platform, options.env)
    const impl = pathImplFor(platform)
    const pathDirs = (options.env.PATH ?? '').split(delimiterFor(platform)).filter((dir) => dir !== '')
    const dirs = [...pathDirs, ...FALLBACK_DIRS[platform]]

    for (const dir of dirs) {
      for (const name of names) {
        const candidate = impl.join(dir, name)
        searched.push(candidate)
        if (await probe(candidate)) {
          cache.set(cacheKey, candidate)
          return { ok: true, path: candidate }
        }
      }
    }

    return { ok: false, kind: 'not-found', command: options.command, searched }
  }

  return { which }
}

const defaultWhich = createWhich()

export const which: (options: WhichOptions) => Promise<WhichResult> = defaultWhich.which
