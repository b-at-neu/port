import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { LocalRepoRef } from '@/types/github'
import type { ListSessionsResult, OpenTailParams, PollTailParams, CloseTailParams, SessionScan } from '@/types/sessions'
import type { PipelineState, RefreshOutcome } from '@/types/state'
import type { RunSearchParams, SearchResult } from '@/types/search'
import type { TranscriptTailOpen, TranscriptTailPoll } from '@/utils/sessions/transcript'

interface RepoRoot {
  readonly repoId: RepoId
  readonly repoRoot: string
}

interface ReposParams {
  readonly repos: readonly LocalRepoRef[]
}

interface GithubParams {
  readonly repoId: RepoId
  readonly repo: { readonly owner: string; readonly name: string }
  readonly vocabulary: LabelVocabulary
}

type SearchParams = Pick<RunSearchParams, 'scan' | 'indexDir' | 'query' | 'scope'>

/** Every method returns a Promise and takes only structured-cloneable data, so the same shape runs in-process or across a worker boundary. */
export interface StateEngine {
  refreshSessions(params: ReposParams): Promise<RefreshOutcome>
  refreshWorktrees(params: RepoRoot): Promise<RefreshOutcome>
  refreshDenials(params: RepoRoot): Promise<RefreshOutcome>
  refreshGithub(params: GithubParams): Promise<RefreshOutcome>
  project(params: { readonly repositories: readonly RepositoryEntry[] }): Promise<PipelineState>
  scanSessions(params: ReposParams): Promise<SessionScan>
  listSessions(): Promise<ListSessionsResult>
  search(params: SearchParams): Promise<SearchResult>
  tailOpen(params: OpenTailParams): Promise<TranscriptTailOpen>
  tailPoll(params: PollTailParams): Promise<TranscriptTailPoll>
  tailClose(params: CloseTailParams): Promise<void>
}

export const OFFLOAD_OPS = [
  'refreshSessions',
  'refreshWorktrees',
  'refreshDenials',
  'refreshGithub',
  'project',
  'scanSessions',
  'listSessions',
  'search',
  'tailOpen',
  'tailPoll',
  'tailClose',
] as const satisfies readonly (keyof StateEngine)[]

export type OffloadOp = (typeof OFFLOAD_OPS)[number]

export type OffloadParams = { [K in OffloadOp]: Parameters<StateEngine[K]>[0] }

export type OffloadValue = { [K in OffloadOp]: Awaited<ReturnType<StateEngine[K]>> }

export interface OffloadRequest {
  readonly id: number
  readonly op: string
  readonly params: unknown
}

export type OffloadResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly message: string }
