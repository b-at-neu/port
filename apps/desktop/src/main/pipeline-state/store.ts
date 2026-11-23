// The pipeline state file's only writer. A transition is never reported as applied until it is on disk.
import { emptyFile, parseFile, prune, recordMirror, seedFrom, transition, trackedOf, viewOf, withItem } from '@/main/pipeline-state/model'
import type { PipelineStateFile, PipelineStateStore, RepoRecord, StoreTransitionResult } from '@/types/pipeline-state'
import type { FileResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'

interface CreatePipelineStateStoreParams {
  /** The file's full path; the composition in `default.ts` is the only place that names it. */
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
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

  async function persist(repoId: RepoId, record: RepoRecord): Promise<FileResult<void>> {
    const result = await params.writeJsonAtomic(params.path, withRecord(repoId, record))
    if (result.ok) file = withRecord(repoId, record)
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
    transition: (repoId, ref, input) =>
      serialize(async (): Promise<StoreTransitionResult> => {
        await ready
        const record = file.repositories[repoId]
        if (record === undefined) return { ok: false, reason: 'precondition-failed' }
        const next = transition(record, ref, input)
        if (!next.ok) return next
        if (!next.changed) return { ok: true, changed: false }
        const written = await persist(repoId, withItem(record, next.item))
        return written.ok ? { ok: true, changed: true } : { ok: false, reason: 'persist-failed', message: written.message }
      }),
  }
}
