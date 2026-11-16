// pipeline-state.json's only writer. A transition is never reported as applied until it is on disk.
import { emptyFile, parseFile, prune, seedFrom, transition, trackedOf, viewOf, withItem } from '@/main/pipeline-state/model'
import type { PipelineItemKind } from '@/types/github'
import type { PipelineStateFile, PipelineView, RepoRecord, StoreTransitionResult, TrackedRef, TransitionInput } from '@/types/pipeline-state'
import type { FileResult } from '@/types/platform'
import type { RepositoryState } from '@/types/state'
import type { RepoId } from '@/utils/repos'

interface CreatePipelineStateStoreParams {
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
}

export interface PipelineStateStore {
  /** Settles once the file has been read; every read and transition waits on it. */
  readonly ready: Promise<void>
  readonly view: (repoId: RepoId) => PipelineView
  readonly tracked: (repoId: RepoId) => readonly TrackedRef[] | null
  readonly seed: (repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>) => Promise<void>
  readonly markHeld: (repoId: RepoId) => void
  readonly prune: (repoId: RepoId, closed: readonly number[]) => Promise<void>
  readonly transition: (repoId: RepoId, ref: { readonly kind: PipelineItemKind; readonly number: number }, input: TransitionInput) => Promise<StoreTransitionResult>
}

export function createPipelineStateStore(params: CreatePipelineStateStoreParams): PipelineStateStore {
  let file: PipelineStateFile = emptyFile()
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

  async function persist(next: PipelineStateFile): Promise<FileResult<void>> {
    const result = await params.writeJsonAtomic(params.path, next)
    if (result.ok) file = next
    return result
  }

  async function load(): Promise<void> {
    const result = await params.readJson<unknown>(params.path)
    if (!result.ok) {
      if (result.kind !== 'not-found') console.error(`[pipeline-state] could not read ${params.path}: ${result.message}`)
      return
    }
    file = parseFile(result.value)
  }

  const ready = load()

  // A seed or prune is derived from labels or GitHub and is redone on the next projection, so a failed write only logs.
  async function persistBestEffort(repoId: RepoId, record: RepoRecord): Promise<void> {
    const next = withRecord(repoId, record)
    file = next
    const result = await params.writeJsonAtomic(params.path, next)
    if (!result.ok) console.error(`[pipeline-state] could not write ${params.path}: ${result.message}`)
  }

  return {
    ready,
    view: (repoId) => viewOf(file.repositories[repoId]),
    tracked: (repoId) => trackedOf(file.repositories[repoId]),
    seed: (repoId, state) =>
      serialize(async () => {
        await ready
        await persistBestEffort(repoId, seedFrom(state, params.now().toISOString()))
      }),
    markHeld: (repoId) => {
      const record = file.repositories[repoId]
      if (record === undefined || record.heldBy !== null) return
      void serialize(async () => {
        await ready
        const current = file.repositories[repoId]
        if (current !== undefined) await persistBestEffort(repoId, { ...current, heldBy: 'terminal' })
      })
    },
    prune: (repoId, closed) =>
      serialize(async () => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return
        const pruned = prune(record, closed)
        if (pruned !== record) await persistBestEffort(repoId, pruned)
      }),
    transition: (repoId, ref, input) =>
      serialize(async (): Promise<StoreTransitionResult> => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return { ok: false, reason: 'precondition-failed' }
        const next = transition(record, ref, input)
        if (!next.ok) return next
        if (!next.changed) return { ok: true, changed: false }
        const written = await persist(withRecord(repoId, withItem(record, next.item)))
        return written.ok ? { ok: true, changed: true } : { ok: false, reason: 'persist-failed', message: written.message }
      }),
  }
}
