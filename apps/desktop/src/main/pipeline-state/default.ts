// Composition: the store, the writer and the view, bound to userData and to who owns each repository.
import { join } from 'node:path'
import { stateLabelsOf } from '@/main/pipeline-state/labels'
import { createPipelineStateStore } from '@/main/pipeline-state/store'
import { createStateWriter } from '@/main/pipeline-state/writer'
import { readOwnership } from '@/main/dispatch/ownership'
import { fetchItemsByNumber } from '@/main/github/adapter'
import { readJsonFile, writeJsonFileAtomic } from '@/main/platform/files'
import { applyLabels } from '@/main/writes/apply'
import { appendAudit } from '@/main/writes/audit'
import type { PipelineView, StateLabelsReader, TrackedRef } from '@/types/pipeline-state'
import type { RepositoryState } from '@/types/state'
import type { WriteState } from '@/types/writes'
import type { RepoId } from '@/utils/repos'

interface CreatePipelineStateParams {
  readonly dir: string
  /** An unknown owner reads as not terminal, the same as an absent record. */
  readonly ownerOf: (repoId: RepoId) => string | null
}

interface PipelineState {
  readonly writeState: WriteState
  readonly stateLabels: StateLabelsReader
  /** The watcher's own seams onto the store, spread into its deps. */
  readonly watcherDeps: {
    readonly pipelineView: (repoId: RepoId) => PipelineView
    readonly trackedRefs: (repoId: RepoId) => readonly TrackedRef[] | null
    readonly seedPipelineState: (repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>) => Promise<void>
    readonly prunePipelineState: (repoId: RepoId, closed: readonly number[]) => Promise<void>
    readonly pipelineReady: () => Promise<void>
  }
}

export function createPipelineState(params: CreatePipelineStateParams): PipelineState {
  const store = createPipelineStateStore({ path: join(params.dir, 'pipeline-state.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date() })
  const writeState = createStateWriter({ store, applyLabels, readOwnership, fetchItemsByNumber, appendAudit, now: () => new Date() })

  // The terminal cockpit keeps the labels as its record, so a repository it holds reads labels; once it leaves, the next read is labels once more so the watcher reseeds.
  function heldByTerminal(repoId: RepoId): boolean {
    if (params.ownerOf(repoId) !== 'terminal') return false
    store.markHeld(repoId)
    return true
  }

  function view(repoId: RepoId): PipelineView {
    return heldByTerminal(repoId) ? { kind: 'labels' } : store.view(repoId)
  }

  return {
    writeState,
    stateLabels: (repoId, kind, number, vocabulary) => stateLabelsOf(view(repoId), kind, number, vocabulary),
    watcherDeps: {
      pipelineView: view,
      trackedRefs: (repoId) => (heldByTerminal(repoId) ? null : store.tracked(repoId)),
      seedPipelineState: (repoId, state) => store.seed(repoId, state),
      prunePipelineState: (repoId, closed) => store.prune(repoId, closed),
      pipelineReady: () => store.ready,
    },
  }
}
