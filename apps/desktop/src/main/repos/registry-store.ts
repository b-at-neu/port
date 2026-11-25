// The app-level registry file. A missing file reads as empty; an unparseable, invalid or newer-version file is reported and never written over (`read-only`).
import { z } from 'zod'
import { createJsonStore, type JsonStore } from '@/main/platform/json-store'
import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'
import type { PathOps } from '@/types/platform'

const REGISTRY_FILE = 'registry.json'
const CURRENT_VERSION = 1

const registrySchema = z.object({ version: z.literal(CURRENT_VERSION), repositories: z.array(z.looseObject({ path: z.unknown() })) })
type RegistryFile = z.infer<typeof registrySchema>

type ReadRegistryResult =
  | { readonly ok: true; readonly repositories: readonly string[] }
  | { readonly ok: false; readonly kind: 'registry-malformed' | 'registry-unsupported-version' | 'registry-unreadable'; readonly message: string }

/** Exported separately from the file I/O so a win32-flavoured dedupe is testable on any host. */
export function dedupePaths(paths: readonly string[], ops: PathOps = pathOps): readonly string[] {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const key = ops.pathKey(path)
    if (!seen.has(key)) seen.set(key, path)
  }
  return [...seen.values()]
}

function registryStore(ctx: Pick<Platform, 'fs'>, dir: string): JsonStore<RegistryFile> {
  return createJsonStore({
    fs: ctx.fs,
    file: pathOps.join(dir, REGISTRY_FILE),
    version: CURRENT_VERSION,
    schema: registrySchema,
    initial: { version: CURRENT_VERSION, repositories: [] },
    unreadable: 'read-only',
  })
}

/** File absent is a value, never an exception. */
export async function readRegistry(ctx: Pick<Platform, 'fs'>, dir: string): Promise<ReadRegistryResult> {
  const store = registryStore(ctx, dir)
  await store.load()
  const status = store.status()
  if (status.kind === 'unreadable') {
    const kind = status.reason === 'malformed' ? 'registry-malformed' : status.reason === 'newer-version' ? 'registry-unsupported-version' : 'registry-unreadable'
    return { ok: false, kind, message: status.message }
  }
  const paths = store.value().repositories.map((entry) => entry.path).filter((path): path is string => typeof path === 'string')
  return { ok: true, repositories: dedupePaths(paths) }
}

type WriteRegistryResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'registry-unwritable'; readonly message: string }

/** Callers must never write when the corresponding read failed, which is why this does not itself read first. */
export async function writeRegistry(ctx: Pick<Platform, 'fs'>, dir: string, paths: readonly string[]): Promise<WriteRegistryResult> {
  const written = await registryStore(ctx, dir).write({ version: CURRENT_VERSION, repositories: dedupePaths(paths).map((path) => ({ path })) })
  if (!written.ok) return { ok: false, kind: 'registry-unwritable', message: written.message }
  return { ok: true }
}
