import { homedir } from 'node:os'
import { posix as posixImpl, win32 as win32Impl } from 'node:path'

type PathImpl = typeof posixImpl

export type PathFlavour = 'posix' | 'win32'

declare const repoKeyBrand: unique symbol

/** Branded string: the canonical identity `pathKey` produces. A raw path
 *  cannot be passed where an identity is expected — nothing else can mint
 *  one, so a call site importing this type is asserting "this came from
 *  `pathKey`", not "this looks like a path". */
export type RepoKey = string & { readonly [repoKeyBrand]: true }

export interface PathOpsOptions {
  readonly home: string
}

export interface PathOps {
  readonly flavour: PathFlavour
  toNative(p: string): string
  toPosix(p: string): string
  pathKey(p: string): RepoKey
  samePath(a: string, b: string): boolean
  contains(parent: string, child: string): boolean
  expandHome(p: string): string
  resolveFrom(base: string, p: string): string
}

function implFor(flavour: PathFlavour): PathImpl {
  return flavour === 'win32' ? win32Impl : posixImpl
}

/** A relative or empty input to an absolute-only op is a programmer mistake —
 *  no config or operator action can produce one — so it throws rather than
 *  returning a value, unlike every other failure mode this layer models. */
function assertAbsolute(impl: PathImpl, p: string, fnName: string): void {
  if (p === '' || !impl.isAbsolute(p)) {
    throw new TypeError(`${fnName} requires an absolute path, got ${JSON.stringify(p)}`)
  }
}

function withSeparator(p: string, sep: string): string {
  return p.replace(/[\\/]+/g, sep)
}

function dropTrailingSeparator(impl: PathImpl, p: string): string {
  const root = impl.parse(p).root
  if (p.length > root.length && p.endsWith(impl.sep)) {
    return p.slice(0, -impl.sep.length)
  }
  return p
}

/**
 * Binds every op to one `node:path` flavour, taking that flavour as a
 * parameter rather than reading `process.platform` — this is what makes the
 * acceptance criterion (Windows-style *and* POSIX-style normalization tests)
 * runnable on any host rather than only on Windows.
 */
export function createPathOps(flavour: PathFlavour, options: PathOpsOptions): PathOps {
  const impl = implFor(flavour)
  const home = options.home

  function toNative(p: string): string {
    assertAbsolute(impl, p, 'toNative')
    return impl.normalize(withSeparator(p, impl.sep))
  }

  function toPosix(p: string): string {
    assertAbsolute(impl, p, 'toPosix')
    return posixImpl.normalize(withSeparator(p, '/'))
  }

  function pathKey(p: string): RepoKey {
    assertAbsolute(impl, p, 'pathKey')
    let key = dropTrailingSeparator(impl, impl.normalize(withSeparator(p, impl.sep)))
    if (flavour === 'win32') {
      // Windows case-insensitivity is a filesystem-level guarantee, and drive
      // letters genuinely arrive in both cases from different callers — fold
      // the whole string, then re-uppercase the drive letter so `C:` reads
      // consistently. Folding on darwin would instead merge two genuinely
      // distinct paths, which is why this branch is win32-only.
      key = key.toLowerCase().replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`)
    }
    return key as RepoKey
  }

  function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b)
  }

  function contains(parent: string, child: string): boolean {
    assertAbsolute(impl, parent, 'contains')
    assertAbsolute(impl, child, 'contains')
    const normParent = toNative(parent)
    const normChild = toNative(child)
    const rel = impl.relative(normParent, normChild)
    if (rel === '' || rel === '..') return false
    if (rel.startsWith(`..${impl.sep}`)) return false
    if (impl.isAbsolute(rel)) return false
    return true
  }

  function expandHome(p: string): string {
    if (p === '~') return home
    if (p.startsWith('~/') || p.startsWith('~\\')) {
      return impl.join(home, p.slice(2))
    }
    return p
  }

  function resolveFrom(base: string, p: string): string {
    assertAbsolute(impl, base, 'resolveFrom')
    return impl.resolve(base, p)
  }

  return { flavour, toNative, toPosix, pathKey, samePath, contains, expandHome, resolveFrom }
}

const hostFlavour: PathFlavour = process.platform === 'win32' ? 'win32' : 'posix'

/** The host-bound instance every adapter reaches for by default. */
export const pathOps: PathOps = createPathOps(hostFlavour, { home: homedir() })
