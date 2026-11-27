// The narrow ctx picks pipeline modules take; a full AppContext satisfies each one structurally.
import type { GitHubReadContext, GitHubWriteContext, TrackerContext } from '@/main/github/context'
import type { Tracker } from '@/main/github/tracker'
import type { Platform } from '@/main/platform'
import { isReadyEntry, type Repos } from '@/main/repos'
import type { ReadyEntry } from '@/types/actions'
import type { AutoPlanner, Dispatcher, RunStateStore } from '@/types/dispatch'
import type { LocalRepoRef } from '@/types/github'
import type { IncidentLog } from '@/types/incidents'
import type { PipelineStateStore, PipelineView, TrackedRef } from '@/types/pipeline-state'
import type { RunSearchParams, SearchResult } from '@/types/search'
import type { ListSessionsResult, OpenTailParams, PollTailParams, CloseTailParams, SessionScan } from '@/types/sessions'
import type { GithubPrecheckOutcome, PipelineState, RefreshOutcome } from '@/types/state'
import type { RunStore } from '@/types/stage'
import type { ForceDispatch, RefreshMemo, RerunMemo, UnknownStreaks } from '@/types/tick'
import type { DisplayVocabulary } from '@/utils/labels/display'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { TranscriptTailOpen, TranscriptTailPoll } from '@/utils/sessions/transcript'

interface RepoRoot {
  readonly repoId: RepoId
  readonly repoRoot: string
}

interface RepoIdParams {
  readonly repoId: RepoId
}

interface ReposParams {
  readonly repos: readonly LocalRepoRef[]
}

interface GithubParams {
  readonly repoId: RepoId
  readonly repo: { readonly owner: string; readonly name: string }
  readonly vocabulary: DisplayVocabulary
  readonly integration: string
  /** The store's tracked items; `null` or absent sweeps GitHub for the seed read. */
  readonly tracked?: readonly TrackedRef[] | null
}

type SearchParams = Pick<RunSearchParams, 'scan' | 'indexDir' | 'query' | 'scope'>

/** Every method returns a Promise and takes only structured-cloneable data, so the same shape runs in-process or across a worker boundary. */
export interface StateEngine {
  refreshSessions(params: ReposParams): Promise<RefreshOutcome>
  refreshWorktrees(params: RepoRoot): Promise<RefreshOutcome>
  refreshDenials(params: RepoRoot): Promise<RefreshOutcome>
  refreshGithub(params: GithubParams): Promise<RefreshOutcome>
  precheckGithub(params: Pick<GithubParams, 'repoId' | 'repo'>): Promise<GithubPrecheckOutcome>
  project(params: { readonly repositories: readonly RepositoryEntry[]; readonly views?: Readonly<Record<string, PipelineView>> }): Promise<PipelineState>
  scanSessions(params: ReposParams): Promise<SessionScan>
  listSessions(): Promise<ListSessionsResult>
  search(params: SearchParams): Promise<SearchResult>
  tailOpen(params: OpenTailParams): Promise<TranscriptTailOpen>
  tailPoll(params: PollTailParams): Promise<TranscriptTailPoll>
  tailClose(params: CloseTailParams): Promise<void>
  forgetRepo(params: RepoIdParams): Promise<void>
}

export interface PipelineStores {
  readonly stores: {
    readonly pipelineState: PipelineStateStore
    readonly incidentLog: Pick<IncidentLog, 'record'>
  }
}

/** The board read: the pull-request half reads GitHub directly, the issue half through the tracker. */
export type BoardReadContext = GitHubReadContext & { readonly tracker: Pick<Tracker, 'readBoardIssues' | 'readItemsByNumber'> }

/** Everything the state writer, the ownership read and the label and comment writes touch. */
export type StateWriteContext = GitHubWriteContext & TrackerContext & Pick<Platform, 'fs'> & PipelineStores

export type OperatorContext = StateWriteContext & { readonly repos: Pick<Repos, 'list'> }

/** The process-lifetime memos the tick, the dispatch loop and the Needs-you override share. */
export interface PipelineMemos {
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly rerunMemo: RerunMemo
  readonly forceDispatch: ForceDispatch
}

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
      readonly memos: PipelineMemos
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
