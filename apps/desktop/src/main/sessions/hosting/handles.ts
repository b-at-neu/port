import type { HostedHandle, HostedSessionSnapshot, SessionKey } from '@/types/hosting'

/** Ended handles retained up to this many; the oldest-ended is evicted on the next `end`. */
export const ENDED_RETAIN_LIMIT = 20

export interface HandleRegistry {
  readonly get: (sessionKey: SessionKey) => HostedHandle | undefined
  readonly set: (sessionKey: SessionKey, handle: HostedHandle) => void
  readonly forget: (sessionKey: SessionKey) => void
  /** Records a status change: the first `ended` one enters the eviction order, dropping the oldest-ended past `ENDED_RETAIN_LIMIT`. */
  readonly noteStatus: (snapshot: HostedSessionSnapshot) => void
  readonly all: () => readonly HostedHandle[]
  readonly list: () => readonly HostedSessionSnapshot[]
  readonly liveCount: () => number
  /** Compares a live handle's `claudeSessionId ?? resumeTarget` against the requested `sessionId`. Never checked for `fork`: a fork of an open session gets a new id, so it is always allowed. */
  readonly findAlreadyOpen: (sessionId: string) => HostedHandle | null
  /** The first live, non-worktree handle whose `cwd` names the same folder as a non-worktree start — two sessions must never share one working tree. */
  readonly findFolderBusy: (cwd: string, samePath: (a: string, b: string) => boolean) => HostedHandle | null
}

export function createHandleRegistry(): HandleRegistry {
  const handles = new Map<SessionKey, HostedHandle>()
  const endedOrder: SessionKey[] = []
  const endedSeen = new Set<SessionKey>()

  function forget(sessionKey: SessionKey): void {
    handles.delete(sessionKey)
    endedSeen.delete(sessionKey)
    const index = endedOrder.indexOf(sessionKey)
    if (index !== -1) endedOrder.splice(index, 1)
  }

  function noteStatus(snapshot: HostedSessionSnapshot): void {
    if (snapshot.phase !== 'ended' || endedSeen.has(snapshot.sessionKey)) return
    endedSeen.add(snapshot.sessionKey)
    endedOrder.push(snapshot.sessionKey)
    while (endedOrder.length > ENDED_RETAIN_LIMIT) {
      const evicted = endedOrder.shift()
      if (evicted !== undefined) forget(evicted)
    }
  }

  function findAlreadyOpen(sessionId: string): HostedHandle | null {
    for (const handle of handles.values()) {
      if (handle.snapshot().phase === 'ended') continue
      const target = handle.snapshot().claudeSessionId ?? handle.resumeTarget
      if (target === sessionId) return handle
    }
    return null
  }

  function findFolderBusy(cwd: string, samePath: (a: string, b: string) => boolean): HostedHandle | null {
    for (const handle of handles.values()) {
      if (handle.snapshot().phase === 'ended') continue
      if (handle.snapshot().workspace.worktree !== null) continue
      if (samePath(handle.cwd, cwd)) return handle
    }
    return null
  }

  return {
    get: (sessionKey) => handles.get(sessionKey),
    set: (sessionKey, handle) => void handles.set(sessionKey, handle),
    forget,
    noteStatus,
    all: () => [...handles.values()],
    list: () => [...handles.values()].map((handle) => handle.snapshot()),
    liveCount: () => [...handles.values()].filter((handle) => handle.snapshot().phase !== 'ended').length,
    findAlreadyOpen,
    findFolderBusy,
  }
}
