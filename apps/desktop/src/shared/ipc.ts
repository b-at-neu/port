import type { AssertEqual } from './assert-type'
import type { RepoId, RepositoryEntry } from './repos'
import type { WorktreesReport } from './reclaimer/types'
import type { SessionScan } from './sessions/types'
import type { TranscriptRead, TranscriptTailOpen, TranscriptTailPoll } from './sessions/transcript'
import type { BoardSnapshot, SourceKind } from './board/types'
import type { ClaimApplyResponse, ClaimPreflightResponse, PlanGateChoice } from './claim/types'
import type { LabelKey } from './labels/vocabulary'
import type { ItemActionResult, OperatorAction } from './actions/types'

export interface AppInfo {
  app: string
  electron: string
  node: string
  chromium: string
}

/** Every failure kind `readRegistry`/`writeRegistry` can report, shared by
 *  all three channels below so a filesystem-level registry problem always
 *  carries the same three variants. */
export type RegistryFailureKind = 'registry-malformed' | 'registry-unsupported-version' | 'registry-unreadable' | 'registry-unwritable'

export type ReposListResponse =
  | { readonly ok: true; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: RegistryFailureKind; readonly message: string }

export type ReposAddResponse =
  | { readonly ok: true; readonly outcome: 'added'; readonly added: RepoId; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: true; readonly outcome: 'cancelled' }
  | { readonly ok: true; readonly outcome: 'already-registered'; readonly existing: RepoId; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: RegistryFailureKind; readonly message: string }

export type ReposRemoveResponse =
  | { readonly ok: true; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: 'not-registered' | 'registry-unwritable'; readonly message: string }

export interface IpcMap {
  'app:info': {
    request: void
    response: AppInfo
  }
  'repos:list': {
    request: void
    response: ReposListResponse
  }
  'repos:add': {
    request: void
    response: ReposAddResponse
  }
  'repos:remove': {
    request: { id: RepoId }
    response: ReposRemoveResponse
  }
  'worktrees:report': {
    request: { id: RepoId }
    response: WorktreesReport
  }
  'sessions:scan': {
    request: void
    response: SessionScan
  }
  'transcript:read': {
    request: { sessionId: string; agentId: string | null }
    response: TranscriptRead
  }
  'transcript:tail:open': {
    request: { sessionId: string; agentId: string | null }
    response: TranscriptTailOpen
  }
  'transcript:tail:poll': {
    request: { tailId: string }
    response: TranscriptTailPoll
  }
  'transcript:tail:close': {
    request: { tailId: string }
    response: void
  }
  /** The board's initial paint — one invoke, no polling of its own; every
   *  later update arrives over the `board:update` event instead (#80). */
  'board:snapshot': {
    request: void
    response: BoardSnapshot
  }
  /** `repoId`/`source` both optional — omitting either widens the force to
   *  every repository or every source; the watcher's own in-flight guard is
   *  what stops a held button from stacking round trips. */
  'board:refresh': {
    request: { repoId?: RepoId; source?: SourceKind }
    response: BoardSnapshot
  }
  /** The claim dialog's read (#93) — resolves one issue's kind, labels,
   *  assignees, blockers, and the viewer's own login, and classifies it, all
   *  server-side; the renderer names an intent, never a precondition. */
  'claim:preflight': {
    request: { repoId: RepoId; number: number }
    response: ClaimPreflightResponse
  }
  /** The claim dialog's write. `confirmedAssignees` is the exact assignee
   *  list the review step displayed — a fresh read that disagrees with it
   *  refuses as `moved` rather than applying a take-over the operator never
   *  actually confirmed. */
  'claim:apply': {
    request: { repoId: RepoId; number: number; planGate: PlanGateChoice; confirmedAssignees: readonly string[] }
    response: ClaimApplyResponse
  }
  /** The board's single-label operator actions (#94) — pause/resume/retry/
   *  gate. The renderer sends an intent, never a label set: `expectedStage`
   *  is the row's own `stageLabel?.key` at click time, used server-side
   *  only to refuse a stale click, never to widen what gets written. */
  'item:action': {
    request: { repoId: RepoId; kind: 'issue' | 'pull-request'; number: number; action: OperatorAction; expectedStage: LabelKey | null }
    response: ItemActionResult
  }
}

export const IPC_CHANNELS = [
  'app:info',
  'repos:list',
  'repos:add',
  'repos:remove',
  'worktrees:report',
  'sessions:scan',
  'transcript:read',
  'transcript:tail:open',
  'transcript:tail:poll',
  'transcript:tail:close',
  'board:snapshot',
  'board:refresh',
  'claim:preflight',
  'claim:apply',
  'item:action',
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

// Fails to compile if IPC_CHANNELS and IpcMap's keys drift apart.
export const _channelsMatchIpcMap: AssertEqual<IpcChannel, keyof IpcMap> = true

/**
 * The main → renderer push direction — a second `as const` list with its own
 * `IpcEventMap` and its own `AssertEqual` pin, beside `IPC_CHANNELS` above,
 * exactly the compile-time contract that list already carries: an event
 * added to one and not the other fails `pnpm typecheck` (#80). The listener
 * receives the payload only, never the Electron event object, which would
 * hand `sender` to a sandboxed renderer.
 */
export interface IpcEventMap {
  'board:update': BoardSnapshot
}

export const IPC_EVENTS = ['board:update'] as const

export type IpcEvent = (typeof IPC_EVENTS)[number]

export const _eventsMatchIpcEventMap: AssertEqual<IpcEvent, keyof IpcEventMap> = true
