import { describe, expect, it } from 'vitest'
import { findAlreadyOpen, findFolderBusy } from './occupancy'
import type { HostedHandle } from './handle'
import type { HostedSessionSnapshot, SessionKey } from '../../shared/hosting/types'
import type { SessionWorkspace } from '../../shared/workspace/types'

const NON_WORKTREE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }
const WORKTREE: SessionWorkspace = { folder: '/repo/.claude/worktrees/session-a', root: '/repo', worktree: { path: '/repo/.claude/worktrees/session-a', branch: 'session/a' }, base: null }

function fakeHandle(overrides: { readonly sessionKey: string; readonly cwd: string; readonly phase?: HostedSessionSnapshot['phase']; readonly workspace?: SessionWorkspace }): HostedHandle {
  const snapshot = {
    sessionKey: overrides.sessionKey as SessionKey,
    phase: overrides.phase ?? 'ready',
    workspace: overrides.workspace ?? NON_WORKTREE,
  } as HostedSessionSnapshot
  return {
    sessionKey: overrides.sessionKey as SessionKey,
    cwd: overrides.cwd,
    resumeTarget: null,
    snapshot: () => snapshot,
  } as unknown as HostedHandle
}

const samePath = (a: string, b: string): boolean => a === b

describe('findAlreadyOpen', () => {
  it('finds a live handle by claudeSessionId', () => {
    const handle = { ...fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo' }), snapshot: () => ({ claudeSessionId: 'abc', phase: 'ready' }) } as HostedHandle
    const handles = new Map([['hosted-1' as SessionKey, handle]])
    expect(findAlreadyOpen(handles, 'abc')).toBe(handle)
  })

  it('ignores an ended handle', () => {
    const handle = { ...fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo' }), snapshot: () => ({ claudeSessionId: 'abc', phase: 'ended' }) } as HostedHandle
    const handles = new Map([['hosted-1' as SessionKey, handle]])
    expect(findAlreadyOpen(handles, 'abc')).toBeNull()
  })
})

describe('findFolderBusy', () => {
  it('finds a live, non-worktree handle in the same folder', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo' })
    const handles = new Map([['hosted-1' as SessionKey, handle]])
    expect(findFolderBusy(handles, '/repo', samePath)).toBe(handle)
  })

  it('allows a different folder', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/other' })
    const handles = new Map([['hosted-1' as SessionKey, handle]])
    expect(findFolderBusy(handles, '/repo', samePath)).toBeNull()
  })

  it('allows a worktree session in the same repository root', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo/.claude/worktrees/session-a', workspace: WORKTREE })
    const handles = new Map([['hosted-1' as SessionKey, handle]])
    expect(findFolderBusy(handles, '/repo', samePath)).toBeNull()
  })

  it('allows an ended handle in the same folder', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo', phase: 'ended' })
    const handles = new Map([['hosted-1' as SessionKey, handle]])
    expect(findFolderBusy(handles, '/repo', samePath)).toBeNull()
  })
})
