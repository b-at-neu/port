// The narrow ctx picks pipeline modules take; a full AppContext satisfies each one structurally.
import type { GitHubReadContext, GitHubWriteContext } from '@/main/github/context'
import type { Platform } from '@/main/platform'
import { isReadyEntry, type Repos } from '@/main/repos'
import type { ReadyEntry } from '@/types/actions'
import type { AutoPlanner, Dispatcher, RunStateStore } from '@/types/dispatch'
import type { IncidentLog } from '@/types/incidents'
import type { StateEngine } from '@/types/offload'
import type { PipelineStateStore } from '@/types/pipeline-state'
import type { RunStore } from '@/types/stage'
import type { ForceDispatch, RefreshMemo, RerunMemo, UnknownStreaks } from '@/types/tick'
import type { RepoId } from '@/utils/repos'

export interface PipelineStores {
  readonly stores: {
    readonly pipelineState: PipelineStateStore
    readonly incidentLog: Pick<IncidentLog, 'record'>
  }
}

/** Everything the state writer, the ownership read and the label and comment writes touch. */
export type StateWriteContext = GitHubReadContext & GitHubWriteContext & Pick<Platform, 'fs'> & PipelineStores

export type OperatorContext = StateWriteContext & { readonly repos: Pick<Repos, 'list'> }

export type WatcherContext = StateWriteContext &
  Pick<Platform, 'paths'> & {
    readonly repos: Pick<Repos, 'list'>
    readonly stores: {
      readonly runs: Pick<RunStore, 'runsOf'>
      readonly runStates: Pick<RunStateStore, 'snapshot'>
    }
    readonly live: {
      readonly engine: StateEngine
      readonly dispatcher: Pick<Dispatcher, 'status' | 'liveStages' | 'holdsSessionRequired' | 'stageLiveness' | 'endedStages'>
      readonly autoPlanner: Pick<AutoPlanner, 'refused'>
      readonly memos: { readonly unknownStreaks: UnknownStreaks; readonly refreshMemo: RefreshMemo; readonly rerunMemo: RerunMemo }
      readonly forceDispatch: ForceDispatch
    }
  }

/** A registered, ready repository by id, or a throw: `unlistable` words the failure to list. */
export async function readyEntryOf(ctx: Pick<OperatorContext, 'repos'>, subject: string, repoId: RepoId, unlistable: (message: string) => string): Promise<ReadyEntry> {
  const result = await ctx.repos.list()
  if (!result.ok) throw new Error(unlistable(result.message))
  const entry = result.repositories.find((repository) => repository.id === repoId)
  if (!entry) throw new Error(`${subject} found no repository registered with id '${repoId}'`)
  if (!isReadyEntry(entry)) throw new Error(`${subject} requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
}
