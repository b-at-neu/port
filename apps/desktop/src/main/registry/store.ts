// The app-level registry file: read, dedupe, version gate, atomic write. Takes its directory as a parameter, so nothing in this module imports Electron.
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '../platform/files'
import { pathOps } from '../platform/paths'
import type { PathOps } from '../platform/paths'

const REGISTRY_FILE = 'registry.json'
const CURRENT_VERSION = 1

export interface RegistryEntry {
  readonly path: string
}

export type ReadRegistryResult =
  | { readonly ok: true; readonly repositories: readonly string[] }
  | { readonly ok: false; readonly kind: 'registry-malformed' | 'registry-unsupported-version' | 'registry-unreadable'; readonly message: string }

interface RegistryFileShape {
  readonly version: number
  readonly repositories: readonly RegistryEntry[]
}

/** Exported separately from the file I/O so a win32-flavoured dedupe is testable on any host. */
export function dedupePaths(paths: readonly string[], ops: PathOps = pathOps): readonly string[] {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const key = ops.pathKey(path)
    if (!seen.has(key)) seen.set(key, path)
  }
  return [...seen.values()]
}

function registryPath(dir: string): string {
  return pathOps.join(dir, REGISTRY_FILE)
}

/** File absent is a value, never an exception. Unparseable JSON or an unsupported `version` are reported and never written over. */
export async function readRegistry(dir: string): Promise<ReadRegistryResult> {
  const result = await readJsonFile<RegistryFileShape>(registryPath(dir))
  if (!result.ok) {
    if (result.kind === 'not-found') return { ok: true, repositories: [] }
    if (result.kind === 'unparseable') return { ok: false, kind: 'registry-malformed', message: result.message }
    return { ok: false, kind: 'registry-unreadable', message: result.message }
  }

  const value = result.value
  if (typeof value !== 'object' || value === null || !Array.isArray(value.repositories)) {
    return { ok: false, kind: 'registry-malformed', message: `${registryPath(dir)} is not a registry file` }
  }
  if (typeof value.version !== 'number' || value.version > CURRENT_VERSION) {
    return {
      ok: false,
      kind: 'registry-unsupported-version',
      message: `${registryPath(dir)} was written by a newer version of Port (version ${String(value.version)})`,
    }
  }

  const paths = value.repositories
    .map((entry: RegistryEntry) => entry.path)
    .filter((path): path is string => typeof path === 'string')
  return { ok: true, repositories: dedupePaths(paths) }
}

export type WriteRegistryResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'registry-unwritable'; readonly message: string }

/** Writes the deduplicated path list atomically. Callers must never write when the corresponding read failed, which is why this does not itself read first. */
export async function writeRegistry(dir: string, paths: readonly string[]): Promise<WriteRegistryResult> {
  const ensured = await ensureDirectory(dir)
  if (!ensured.ok) return { ok: false, kind: 'registry-unwritable', message: ensured.message }

  const value: RegistryFileShape = { version: CURRENT_VERSION, repositories: dedupePaths(paths).map((path) => ({ path })) }
  const written = await writeJsonFileAtomic(registryPath(dir), value)
  if (!written.ok) return { ok: false, kind: 'registry-unwritable', message: written.message }
  return { ok: true }
}
