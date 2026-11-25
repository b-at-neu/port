// Composition: the store, the writer and the view, bound to userData.
import { join } from 'node:path'
import { createPipelineFinish } from '@/main/pipeline/state/finish'
import { stateLabelsOf } from '@/main/pipeline/state/labels'
import { createRunStateStore } from '@/main/pipeline/state/run-state'
import { createRunStore } from '@/main/pipeline/state/run-store'
import { createPipelineStateStore } from '@/main/pipeline/state/store'
import { createStateWriter } from '@/main/pipeline/state/writer'
import { fetchItemsByNumber } from '@/main/github/adapter'
import { readJsonFile, removeFile, writeJsonFileAtomic } from '@/main/platform/files'
import { applyLabels } from '@/main/github/writes/apply'
import { appendAudit } from '@/main/github/writes/audit'
import type { GitHubReadContext, GitHubWriteContext } from '@/main/github/context'
import type { ReadyEntry } from '@/types/actions'
import type { OwnershipParams, OwnershipRead, RunStateStore } from '@/types/dispatch'
import type { RecordIncident } from '@/types/incidents'
import type { PipelineItemKind } from '@/types/github'
import type { PipelineView, StateLabelsReader, TrackedRef } from '@/types/pipeline-state'
import type { RunStore } from '@/types/stage'
import type { RepositoryState } from '@/types/state'
import type { WriteEvent, WriteState } from '@/types/writes'
import type { Run, Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

interface CreatePipelineStateParams {
  readonly dir: string
  /** Where the audit log lives; the mirror writes the store makes on its own are audited there. */
  readonly auditDir: string
  readonly recordIncident: RecordIncident
  readonly readOwnership: (params: OwnershipParams) => Promise<OwnershipRead>
  readonly platform: GitHubWriteContext & GitHubReadContext
}

interface PipelineState {
  readonly writeState: WriteState
  readonly writeEvent: WriteEvent
  readonly runs: RunStore
  readonly runStates: RunStateStore
  readonly ticketOf: (repoId: RepoId, kind: PipelineItemKind, number: number) => Ticket | null
  readonly stateLabels: StateLabelsReader
  /** The watcher's own seams onto the store, spread into its deps. */
  readonly watcherDeps: {
    readonly runsOf: (repoId: RepoId, kind: PipelineItemKind, number: number) => readonly Run[]
    readonly pipelineView: (repoId: RepoId) => PipelineView
    readonly trackedRefs: (repoId: RepoId) => readonly TrackedRef[] | null
    readonly seedPipelineState: (repoId: RepoId, state: Extract<RepositoryState, { readonly ok: true }>) => Promise<void>
    readonly finishPipelineState: (entry: ReadyEntry, finished: { readonly closed: readonly number[]; readonly merged: readonly number[] }) => Promise<void>
    readonly retryMirrors: (entry: ReadyEntry) => Promise<void>
    readonly pipelineReady: () => Promise<void>
  }
}

export function createPipelineState(params: CreatePipelineStateParams): PipelineState {
  const path = join(params.dir, 'pipeline-state.json')
  const legacy = { dispatch: join(params.dir, 'dispatch.json'), sessions: join(params.dir, 'stage-sessions.json'), denials: join(params.dir, 'stage-denials.json') }
  const store = createPipelineStateStore({ path, legacy, readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, remove: removeFile, now: () => new Date() })
  const runs = createRunStore({ store, newId: () => globalThis.crypto.randomUUID(), now: () => new Date() })
  const { writeState, writeEvent, mirrorItem } = createStateWriter({ store, applyLabels: (p) => applyLabels(params.platform, p), readOwnership: params.readOwnership, fetchItemsByNumber: (p) => fetchItemsByNumber(params.platform, p), appendAudit, recordIncident: params.recordIncident, newId: () => globalThis.crypto.randomUUID(), now: () => new Date() })
  const { finishPipelineState, retryMirrors } = createPipelineFinish({ store, mirrorItem, auditDir: params.auditDir })

  return {
    writeState,
    writeEvent,
    runs,
    runStates: createRunStateStore(store, path),
    ticketOf: (repoId, kind, number) => store.ticket(repoId, { kind, number }),
    stateLabels: (repoId, kind, number, vocabulary) => stateLabelsOf(store.view(repoId), kind, number, vocabulary),
    watcherDeps: {
      runsOf: (repoId, kind, number) => runs.runsOf(repoId, kind, number),
      pipelineView: (repoId) => store.view(repoId),
      trackedRefs: (repoId) => store.tracked(repoId),
      seedPipelineState: (repoId, state) => store.seed(repoId, state),
      finishPipelineState,
      retryMirrors,
      pipelineReady: () => store.ready,
    },
  }
}
