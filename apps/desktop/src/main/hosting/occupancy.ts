// Pure occupancy checks over live handles — moved out of store.ts so folder-busy's own search sits
// beside the already-open one it composes with, never duplicated inline.
import type { HostedHandle } from './handle'
import type { SessionKey } from '../../shared/hosting/types'

/** Compares a live handle's `claudeSessionId ?? resumeTarget` against the requested `sessionId`.
 *  Never checked for `fork`: a fork of an open session gets a new id, so it is always allowed. */
export function findAlreadyOpen(handles: ReadonlyMap<SessionKey, HostedHandle>, sessionId: string): HostedHandle | null {
  for (const handle of handles.values()) {
    if (handle.snapshot().phase === 'ended') continue
    const target = handle.snapshot().claudeSessionId ?? handle.resumeTarget
    if (target === sessionId) return handle
  }
  return null
}

/** The first live, non-worktree handle whose `cwd` names the same folder as a non-worktree start —
 *  two sessions must never share one working tree. */
export function findFolderBusy(handles: ReadonlyMap<SessionKey, HostedHandle>, cwd: string, samePath: (a: string, b: string) => boolean): HostedHandle | null {
  for (const handle of handles.values()) {
    if (handle.snapshot().phase === 'ended') continue
    if (handle.snapshot().workspace.worktree !== null) continue
    if (samePath(handle.cwd, cwd)) return handle
  }
  return null
}
