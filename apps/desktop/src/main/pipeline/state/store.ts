// The pipeline state file's only writer. A transition is never reported as applied until it is on disk.
import { z } from 'zod'
import { createJsonStore } from '@/main/platform/json-store'
import { migrateV1 } from '@/main/pipeline/state/migrate'
import { migrateRuns, NO_RUN_FILES, type RunFiles } from '@/main/pipeline/state/migrate-runs'
import { FILE_VERSION, emptyFile, parseFile, prune, recordMirror, seedFrom, ticketFor, trackedOf, viewOf, withTicket } from '@/main/pipeline/state/model'
import { isOpen, recoverRuns, ticketOfRun } from '@/main/pipeline/runs'
import { applyEvent } from '@/main/pipeline/transitions'
import type { DispatchEntry, PipelineStateFile, PipelineStateStore, RepoRecord, StoreApplyResult, UnsettledRun } from '@/types/pipeline-state'
import type { FileResult } from '@/types/platform'
import type { TicketEvent } from '@/types/stage-labels'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

interface CreatePipelineStateStoreParams {
  /** The file's full path; the composition in `default.ts` is the only place that names it. */
  readonly path: string
  /** The three files version 3 replaces, read once for the migration and deleted once the new file is written. */
  readonly legacy: { readonly dispatch: string; readonly sessions: string; readonly denials: string }
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly remove: (path: string) => Promise<FileResult<void>>
  readonly now: () => Date
}

// `reset`: a missing, malformed or newer-version file is empty and the next write replaces it, so every repository reads paused and reseeds from labels, and only history and runs are lost; a bad ticket is dropped by `parseFile`, never its repository.
const fileSchema = z.object({ version: z.literal(FILE_VERSION), dispatch: z.record(z.string(), z.unknown()), repositories: z.record(z.string(), z.object({ seededAt: z.string(), tickets: z.record(z.string(), z.unknown()) })) })

function migrateFile(from: number, raw: unknown, files: RunFiles | undefined): unknown {
  if (from === 1) return migrateRuns(migrateV1(from, raw), NO_RUN_FILES)
  if (from === 2) return migrateRuns(raw, files ?? NO_RUN_FILES)
  throw new Error(`no migration from pipeline state version ${String(from)}`)
}

export function createPipelineStateStore(params: CreatePipelineStateStoreParams): PipelineStateStore {
  const store = createJsonStore<z.infer<typeof fileSchema>, RunFiles>({
    file: params.path,
    version: FILE_VERSION,
    schema: fileSchema,
    migrate: migrateFile,
    initial: emptyFile(),
    unreadable: 'reset',
    fs: { readJson: params.readJson, writeJsonAtomic: params.writeJsonAtomic },
  })
  let file: PipelineStateFile = emptyFile()
  const replays = new Map<RepoId, UnsettledRun[]>()
  // One serialized chain, so two transitions never interleave their check and commit.
  let chain: Promise<unknown> = Promise.resolve()

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn)
    chain = result.catch(() => undefined)
    return result
  }

  function withRecord(repoId: RepoId, record: RepoRecord): PipelineStateFile {
    return { ...file, repositories: { ...file.repositories, [repoId]: record } }
  }

  async function commit(next: PipelineStateFile): Promise<FileResult<void>> {
    const result = await store.write(next)
    if (result.ok) file = next
    return result.ok ? { ok: true, value: undefined } : { ok: false, kind: 'io', message: result.message }
  }

  async function persist(repoId: RepoId, record: RepoRecord): Promise<FileResult<void>> {
    return commit(withRecord(repoId, record))
  }

  /** The three old files, only when the file on disk is version 2: older ones pre-date them. */
  async function legacyFiles(): Promise<RunFiles | null> {
    const peek = await params.readJson<{ version?: unknown }>(params.path)
    if (!peek.ok || peek.value.version !== 2) return null
    const read = async (path: string): Promise<unknown> => {
      const result = await params.readJson<unknown>(path)
      return result.ok ? result.value : null
    }
    return { dispatch: await read(params.legacy.dispatch), sessions: await read(params.legacy.sessions), denials: await read(params.legacy.denials) }
  }

  async function removeLegacy(): Promise<void> {
    for (const path of Object.values(params.legacy)) {
      const removed = await params.remove(path)
      if (!removed.ok && removed.kind !== 'not-found') console.error(`[pipeline-state] could not delete ${path}: ${removed.message}`)
    }
  }

  /** Marks every run a lost process left open `crash`, in one write, and keeps the hand-backs that never reached their labels. */
  async function recover(): Promise<void> {
    const tickets = Object.values(file.repositories).flatMap((record) => Object.values(record.tickets))
    const { changes, replays: found } = recoverRuns(tickets)
    for (const unsettled of found) replays.set(unsettled.ticket.repo, [...(replays.get(unsettled.ticket.repo) ?? []), unsettled])
    if (changes.length === 0) return
    const at = params.now().toISOString()
    let next = file
    for (const { repo, ticket: number, runId, change } of changes) {
      const record = next.repositories[repo]
      const held = record?.tickets[String(number)]
      if (record === undefined || held === undefined) continue
      const result = applyEvent(held, { kind: 'run', runId, change }, { at, actor: null, repo, ref: { kind: 'issue', number } })
      if (result.ok && result.changed) next = { ...next, repositories: { ...next.repositories, [repo]: withTicket(record, result.ticket) } }
    }
    const written = await commit(next)
    if (!written.ok) {
      console.error(`[pipeline-state] could not write ${params.path}: ${written.message}`)
      file = next
    }
  }

  async function load(): Promise<void> {
    const files = await legacyFiles()
    const loaded = await store.load(files ?? undefined)
    const status = store.status()
    if (status.kind === 'unreadable') {
      console.error(`[pipeline-state] could not read ${params.path}: ${status.message}`)
      return
    }
    file = parseFile(store.value())
    if (files !== null && loaded.migrated && loaded.written) await removeLegacy()
    await recover()
  }

  const ready = load()

  // A seed or prune is derived from labels or GitHub and is redone on the next projection, so a failed write only logs.
  async function persistBestEffort(repoId: RepoId, record: RepoRecord): Promise<void> {
    const next = withRecord(repoId, record)
    file = next
    const result = await store.write(next)
    if (!result.ok) console.error(`[pipeline-state] could not write ${params.path}: ${result.message}`)
  }

  async function applyTo(repoId: RepoId, record: RepoRecord, existing: Ticket | null, event: TicketEvent, ref: { readonly kind: 'issue' | 'pull-request'; readonly number: number }): Promise<StoreApplyResult> {
    const result = applyEvent(existing, event, { at: params.now().toISOString(), actor: null, repo: repoId, ref })
    if (!result.ok) return result
    if (!result.changed) return { ok: true, ticket: result.ticket, changed: false }
    const written = await persist(repoId, withTicket(record, result.ticket))
    return written.ok ? { ok: true, ticket: result.ticket, changed: true } : { ok: false, reason: 'persist-failed', message: written.message }
  }

  return {
    ready,
    view: (repoId) => viewOf(file.repositories[repoId]),
    tracked: (repoId) => trackedOf(file.repositories[repoId]),
    ticket: (repoId, ref) => {
      const record = file.repositories[repoId]
      return record === undefined ? null : ticketFor(record, ref, null)
    },
    tickets: (repoId) => {
      const record = file.repositories[repoId]
      return record === undefined ? null : Object.values(record.tickets)
    },
    allTickets: () => Object.values(file.repositories).flatMap((record) => Object.values(record.tickets)),
    status: () => {
      const status = store.status()
      return status.kind === 'loaded' ? { kind: 'loaded' } : { kind: 'unreadable', message: status.message, path: status.path }
    },
    seed: (repoId, state) =>
      serialize(async () => {
        await ready
        await persistBestEffort(repoId, seedFrom(repoId, state, params.now().toISOString()))
      }),
    prune: (repoId, closed) =>
      serialize(async () => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return
        const pruned = prune(record, closed)
        if (pruned !== record) await persistBestEffort(repoId, pruned)
      }),
    recordMirror: (repoId, ref, failure) =>
      serialize(async () => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return
        const next = recordMirror(record, ref, failure)
        if (next !== record) await persistBestEffort(repoId, next)
      }),
    apply: (repoId, ref, event, expectedRev) =>
      serialize(async (): Promise<StoreApplyResult> => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return { ok: false, reason: 'unseeded' }
        const existing = ticketFor(record, ref, event.kind === 'labels' ? event.issue : null)
        if (expectedRev !== null && existing?.rev !== expectedRev) return { ok: false, reason: 'stale' }
        return applyTo(repoId, record, existing, event, ref)
      }),
    startRun: (repoId, run) =>
      serialize(async (): Promise<StoreApplyResult> => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return { ok: false, reason: 'unseeded' }
        return applyTo(repoId, record, ticketFor(record, run.item, null), { kind: 'run-start', run }, run.item)
      }),
    applyRun: (repoId, runId, change) =>
      serialize(async (): Promise<StoreApplyResult> => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return { ok: false, reason: 'unseeded' }
        const held = ticketOfRun(Object.values(record.tickets), runId)
        return applyTo(repoId, record, held, { kind: 'run', runId, change }, { kind: 'issue', number: held?.ticket ?? 0 })
      }),
    quitRuns: () =>
      serialize(async () => {
        await ready
        const at = params.now().toISOString()
        let next = file
        for (const [repoId, record] of Object.entries(file.repositories)) {
          let current = record
          for (const held of Object.values(record.tickets)) {
            let ticket = held
            for (const run of held.runs.filter(isOpen)) {
              const result = applyEvent(ticket, { kind: 'run', runId: run.id, change: { kind: 'quit' } }, { at, actor: null, repo: repoId as RepoId, ref: { kind: 'issue', number: held.ticket } })
              if (result.ok) ticket = result.ticket
            }
            if (ticket !== held) current = withTicket(current, ticket)
          }
          if (current !== record) next = { ...next, repositories: { ...next.repositories, [repoId]: current } }
        }
        if (next === file) return
        const written = await commit(next)
        if (!written.ok) console.error(`[pipeline-state] could not write ${params.path}: ${written.message}`)
      }),
    takeReplays: (repoId) => {
      const found = replays.get(repoId) ?? []
      replays.delete(repoId)
      return found
    },
    runStates: () => file.dispatch,
    writeRunStates: (next: Readonly<Record<string, DispatchEntry>>) =>
      serialize(async () => {
        await ready
        return commit({ ...file, dispatch: next })
      }),
  }
}
