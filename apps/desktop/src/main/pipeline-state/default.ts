// Composition: the store, the writer and the view, bound to userData.
import { join } from 'node:path'
import { createPipelineFinish } from '@/main/pipeline-state/finish'
import { stateLabelsOf } from '@/main/pipeline-state/labels'
import { createPipelineStateStore } from '@/main/pipeline-state/store'
import { createStateWriter } from '@/main/pipeline-state/writer'
import { readOwnership } from '@/main/dispatch/ownership'
import { fetchItemsByNumber } from '@/main/github/adapter'
import { readJsonFile, writeJsonFileAtomic } from '@/main/platform/files'
import { applyLabels } from '@/main/writes/apply'
import { appendAudit } from '@/main/writes/audit'
import type { ReadyEntry } from '@/types/actions'
import type { RecordIncident } from '@/types/incidents'
import type { PipelineView, StateLabelsReader, TrackedRef } from '@/types/pipeline-state'
import type { RepositoryState } from '@/types/state'
import type { WriteState } from '@/types/writes'
import type { RepoId } from '@/utils/repos'

interface CreatePipelineStateParams {
  readonly dir: string
  /** Where the audit log lives; the mirror writes the store makes on its own are audited there. */
  readonly auditDir: string
  readonly recordIncident: RecordIncident
}

interface PipelineState {
  readonly writeState: WriteState
  readonly stateLabels: StateLabelsReader
  /** The watcher's own seams onto the store, spread into its deps. */
  readonly watcherDeps: {
    readonly pipelineView: (repoId: RepoId) => PipelineView
    readonly trackedRefs: (repoId: RepoId) => readonly TrackedRef[] | null
    readonly seedPipelineState: (repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>) => Promise<void>
    readonly finishPipelineState: (entry: ReadyEntry, finished: { readonly closed: readonly number[]; readonly merged: readonly number[] }) => Promise<void>
    readonly retryMirrors: (entry: ReadyEntry) => Promise<void>
    readonly pipelineReady: () => Promise<void>
  }
}

export function createPipelineState(params: CreatePipelineStateParams): PipelineState {
  const store = createPipelineStateStore({ path: join(params.dir, 'pipeline-state.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date() })
  const { writeState, mirrorItem } = createStateWriter({ store, applyLabels, readOwnership, fetchItemsByNumber, appendAudit, recordIncident: params.recordIncident, newId: () => globalThis.crypto.randomUUID(), now: () => new Date() })
  const { finishPipelineState, retryMirrors } = createPipelineFinish({ store, mirrorItem, auditDir: params.auditDir })

  return {
    writeState,
    stateLabels: (repoId, kind, number, vocabulary) => stateLabelsOf(store.view(repoId), kind, number, vocabulary),
    watcherDeps: {
      pipelineView: (repoId) => store.view(repoId),
      trackedRefs: (repoId) => store.tracked(repoId),
      seedPipelineState: (repoId, state) => store.seed(repoId, state),
      finishPipelineState,
      retryMirrors,
      pipelineReady: () => store.ready,
    },
  }
}
