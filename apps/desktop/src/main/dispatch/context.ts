// The narrow ctx picks the dispatch modules take; a full AppContext satisfies each one structurally.
import type { GitHubReadContext, LedgerWriteContext } from '@/main/github/context'
import type { PipelineMemos, StateWriteContext } from '@/main/pipeline/context'
import type { Platform } from '@/main/platform'
import type { Repos } from '@/main/repos'
import type { Dispatcher, RunStateStore } from '@/types/dispatch'
import type { HostedStore } from '@/types/hosting'
import type { RunStore, StageLauncherHandle } from '@/types/stage'
import type { PipelineWatcher } from '@/types/state'
import type { RepoId } from '@/utils/repos'

export interface DispatchLive {
  readonly hostedStore: Pick<HostedStore, 'snapshotOf' | 'list' | 'capacity' | 'close' | 'start' | 'send' | 'dismiss'>
  readonly stageLauncher: StageLauncherHandle
  readonly dispatcher: Dispatcher
  readonly watcher: Pick<PipelineWatcher, 'republish' | 'refresh' | 'snapshot'>
  readonly memos: PipelineMemos
}

export type DispatchContext = StateWriteContext &
  LedgerWriteContext &
  Pick<Platform, 'paths' | 'git' | 'clock'> & {
    readonly repos: Pick<Repos, 'list'>
    readonly stores: { readonly runs: RunStore; readonly runStates: RunStateStore }
    readonly live: Pick<DispatchLive, 'hostedStore' | 'stageLauncher' | 'watcher' | 'memos'>
  }

export type AutoPlanContext = StateWriteContext &
  Pick<Platform, 'git' | 'clock' | 'paths'> & {
    readonly repos: Pick<Repos, 'list'>
    readonly stores: { readonly runStates: RunStateStore }
    readonly live: { readonly watcher: Pick<PipelineWatcher, 'republish' | 'refresh'> }
  }

export type HaltContext = StateWriteContext &
  Pick<Platform, 'clock' | 'paths'> & {
    readonly stores: { readonly runStates: RunStateStore }
    readonly live: { readonly dispatcher: Pick<Dispatcher, 'stopFor' | 'standDown'> }
  }

export type StageLaunchContext = Pick<Platform, 'git' | 'fs' | 'clock' | 'paths'> & {
  readonly stores: { readonly runs: RunStore }
  readonly live: {
    readonly hostedStore: Pick<HostedStore, 'list' | 'close' | 'start' | 'send' | 'dismiss'>
    readonly dispatcher: Pick<Dispatcher, 'recordOutcome' | 'recordResumedTurn'>
  }
}

export type RecoverContext = StateWriteContext &
  Pick<Platform, 'paths'> & {
    readonly repos: Pick<Repos, 'list'>
    readonly stores: { readonly runs: RunStore }
    readonly live: {
      readonly hostedStore: Pick<HostedStore, 'list' | 'capacity'>
      readonly stageLauncher: Pick<StageLauncherHandle, 'resume'>
      readonly watcher: Pick<PipelineWatcher, 'snapshot'>
    }
  }

export type SweepContext = RecoverContext &
  GitHubReadContext & {
    readonly live: { readonly watcher: Pick<PipelineWatcher, 'republish'> }
  }

/** A failed read is retried by the scheduled poll, so it is never surfaced here. */
export function requestRead(ctx: { readonly live: { readonly watcher: Pick<PipelineWatcher, 'refresh'> } }, repoId: RepoId): void {
  void ctx.live.watcher.refresh({ repoId, source: 'github' }).catch(() => undefined)
}
