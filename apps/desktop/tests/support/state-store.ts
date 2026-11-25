import { createRunStore } from '@/main/pipeline/state/run-store'
import { createPipelineStateStore } from '@/main/pipeline/state/store'
import type { Platform } from '@/main/platform'
import type { FileResult, PlatformFs } from '@/types/platform'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { createFakeClock, createFakeFs } from './fake-platform'

export const AT = '2026-11-23T12:00:00.000Z'

interface MemoryStoreOptions {
  /** `null` leaves the repository unseeded. */
  readonly tickets: readonly Ticket[] | null
  readonly persistFails?: boolean
  /** The instant the store's clock reads; defaults to `AT`. */
  readonly at?: string
}

/** The state file's full path under `storeCtx`. */
export const STATE_PATH = '/data/pipeline-state.json'

/** A platform whose file reads, writes and removals are the three given members; everything else is the in-memory fs. */
export function storeCtx(fs: Pick<PlatformFs, 'readJson' | 'writeJsonAtomic' | 'remove'>, at: string = AT): Pick<Platform, 'fs' | 'clock' | 'paths'> {
  const clock = createFakeClock(at)
  return { paths: { userData: '/data', temp: '/data/tmp', logs: '/data/logs' }, clock, fs: { ...createFakeFs(clock), ...fs } }
}

/** The real pipeline state store over an in-memory file, seeded with `tickets` for `repoId`. */
export function memoryStore(repoId: RepoId, options: MemoryStoreOptions) {
  const writes: unknown[] = []
  const file =
    options.tickets === null
      ? { ok: false as const, kind: 'not-found' as const, message: 'missing' }
      : { ok: true as const, value: { version: 3, dispatch: {}, repositories: { [repoId]: { seededAt: AT, tickets: Object.fromEntries(options.tickets.map((ticket) => [String(ticket.ticket), ticket])) } } } }
  const store = createPipelineStateStore(
    storeCtx(
      {
        readJson: <T>() => Promise.resolve(file as FileResult<T>),
        writeJsonAtomic: (_path, value) => {
          if (options.persistFails === true) return Promise.resolve({ ok: false, kind: 'io', message: 'disk full' })
          writes.push(value)
          return Promise.resolve({ ok: true, value: undefined })
        },
        remove: () => Promise.resolve({ ok: true, value: undefined }),
      },
      options.at,
    ),
  )
  return { store, writes }
}

/** A run store over the same in-memory file; ids count up from `run-1`. */
export function memoryRuns(repoId: RepoId, options: MemoryStoreOptions) {
  const made = memoryStore(repoId, options)
  let n = 0
  const runs = createRunStore({ store: made.store, newId: () => `run-${String((n += 1))}`, now: () => new Date(options.at ?? AT) })
  return { ...made, runs }
}
