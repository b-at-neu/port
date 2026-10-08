// Session start/send/stop/close/dismiss, plus the cross-screen entry points the sidebar, palette and keyboard map call directly.
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { router } from '../router/router'
import { ROUTE_IDS } from '../router/routes'
import { ipcQueryOptions } from '../data/query'
import { invoke } from '../data/invoke'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { ReposListResponse } from '../../../shared/ipc'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult } from '../../../shared/hosting/types'
import { startFailureCopy, START_UNREACHABLE } from './copy'
import type { StartFailureCopy } from './copy'
import { clearDraft } from './drafts'
import { forgetSessionEntries } from './entries-store'

let queryClient: QueryClient | null = null

/** Called once from `main.ts`'s boot, the same seam `currentRepositories` there already uses. */
export function setSessionsQueryClient(client: QueryClient): void {
  queryClient = client
}

function sessionListKey() {
  return ipcQueryOptions('session:list').queryKey
}

function putSession(snapshot: HostedSessionSnapshot): void {
  if (queryClient === null) return
  const key = sessionListKey()
  const existing = queryClient.getQueryData<readonly HostedSessionSnapshot[]>(key)
  if (existing === undefined) {
    void queryClient.invalidateQueries({ queryKey: key })
    return
  }
  const found = existing.some((entry) => entry.sessionKey === snapshot.sessionKey)
  queryClient.setQueryData(key, found ? existing.map((entry) => (entry.sessionKey === snapshot.sessionKey ? snapshot : entry)) : [...existing, snapshot])
}

function removeSession(key: SessionKey): void {
  if (queryClient === null) return
  const listKey = sessionListKey()
  const existing = queryClient.getQueryData<readonly HostedSessionSnapshot[]>(listKey)
  if (existing === undefined) return
  queryClient.setQueryData(
    listKey,
    existing.filter((entry) => entry.sessionKey !== key),
  )
}

function repoLabelFor(repoId: RepoId): string {
  const data = queryClient?.getQueryData<ReposListResponse>(ipcQueryOptions('repos:list').queryKey)
  if (data?.ok !== true) return repoId
  const entry = data.repositories.find((candidate: RepositoryEntry) => candidate.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function liveSessionKeys(): readonly SessionKey[] {
  const data = queryClient?.getQueryData<readonly HostedSessionSnapshot[]>(sessionListKey()) ?? []
  return data.filter((snapshot) => snapshot.phase !== 'ended').map((snapshot) => snapshot.sessionKey)
}

export interface PendingStart {
  readonly repoLabel: string
}

const pendingStartListeners = new Set<() => void>()
let pendingStart: PendingStart | null = null

function setPendingStart(next: PendingStart | null): void {
  pendingStart = next
  for (const listener of pendingStartListeners) listener()
}

export function usePendingStart(): PendingStart | null {
  return useSyncExternalStore(
    (listener) => {
      pendingStartListeners.add(listener)
      return () => pendingStartListeners.delete(listener)
    },
    () => pendingStart,
  )
}

const startFailureListeners = new Set<() => void>()
let startFailure: StartFailureCopy | null = null

function setStartFailure(next: StartFailureCopy | null): void {
  startFailure = next
  for (const listener of startFailureListeners) listener()
}

export function useStartFailure(): StartFailureCopy | null {
  return useSyncExternalStore(
    (listener) => {
      startFailureListeners.add(listener)
      return () => startFailureListeners.delete(listener)
    },
    () => startFailure,
  )
}

function handleStartResult(result: SessionStartResult): void {
  setPendingStart(null)
  if (result.ok) {
    setStartFailure(null)
    putSession(result.snapshot)
    void router.navigate({ to: ROUTE_IDS.session, search: { key: result.snapshot.sessionKey } })
    return
  }
  if (result.kind === 'already-open') {
    setStartFailure(null)
    void router.navigate({ to: ROUTE_IDS.session, search: { key: result.sessionKey } })
    return
  }
  setStartFailure(startFailureCopy(result))
}

async function startSession(repoId: RepoId): Promise<void> {
  setPendingStart({ repoLabel: repoLabelFor(repoId) })
  setStartFailure(null)
  void router.navigate({ to: ROUTE_IDS.session, search: {} })
  try {
    const result = await invoke('session:start', { repoId, mode: { kind: 'fresh' } })
    handleStartResult(result)
  } catch (error) {
    console.error('Failed to reach the main process starting a session', error)
    setPendingStart(null)
    setStartFailure({ title: 'Could not start a session', body: START_UNREACHABLE, detail: null })
  }
}

/** The sidebar's and palette's **New session** entry point. */
export function startNewSession(repoId: RepoId): void {
  void startSession(repoId)
}

/** The sidebar's own session row click, and the keyboard map's jump/next. */
export function selectSession(key: SessionKey): void {
  void router.navigate({ to: ROUTE_IDS.session, search: { key } })
}

export interface SendOutcome {
  readonly ok: boolean
  readonly error: string | null
}

export async function send(key: SessionKey, text: string): Promise<SendOutcome> {
  try {
    const result = await invoke('session:send', { sessionKey: key, text })
    return result.ok ? { ok: true, error: null } : { ok: false, error: 'unknown-session' }
  } catch (error) {
    console.error('Failed to reach the main process sending a message', error)
    return { ok: false, error: 'unreachable' }
  }
}

export async function stop(key: SessionKey): Promise<number | null | 'unreachable'> {
  try {
    const result = await invoke('session:interrupt', { sessionKey: key })
    return result.ok ? result.queuedAfterInterrupt : null
  } catch (error) {
    console.error('Failed to reach the main process interrupting a session', error)
    return 'unreachable'
  }
}

export async function close(key: SessionKey): Promise<void> {
  try {
    await invoke('session:close', { sessionKey: key })
  } catch (error) {
    console.error('Failed to reach the main process closing a session', error)
  }
}

export async function dismiss(key: SessionKey): Promise<boolean> {
  try {
    const result = await invoke('session:dismiss', { sessionKey: key })
    if (!result.ok) return false
    removeSession(key)
    forgetSessionEntries(key)
    clearDraft(key)
    return true
  } catch (error) {
    console.error('Failed to reach the main process dismissing a session', error)
    return false
  }
}

export async function startFromTranscript(repoId: RepoId, sessionId: string, kind: 'resume' | 'fork'): Promise<void> {
  try {
    const result = await invoke('session:start', { repoId, mode: { kind, sessionId } })
    handleStartResult(result)
  } catch (error) {
    console.error('Failed to reach the main process starting a session from a transcript', error)
  }
}
