import type { AssertEqual } from './assert-type'
import type { RepoId, RepositoryEntry } from './repos'
import type { WorktreesReport } from './reclaimer/types'

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
}

export const IPC_CHANNELS = ['app:info', 'repos:list', 'repos:add', 'repos:remove', 'worktrees:report'] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

// Fails to compile if IPC_CHANNELS and IpcMap's keys drift apart.
export const _channelsMatchIpcMap: AssertEqual<IpcChannel, keyof IpcMap> = true
