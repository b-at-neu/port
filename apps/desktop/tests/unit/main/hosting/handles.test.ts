import { describe, expect, it } from 'vitest'
import { createHandleRegistry } from '@/main/sessions/hosting/handles'

import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { SessionWorkspace } from '@/types/workspace'
import type { HostedHandle } from '@/types/hosting'

const NON_WORKTREE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }
const WORKTREE: SessionWorkspace = { folder: '/repo/.claude/worktrees/session-a', root: '/repo', worktree: { path: '/repo/.claude/worktrees/session-a', branch: 'session/a' }, base: null }

function fakeHandle(overrides: { readonly sessionKey: string; readonly cwd: string; readonly phase?: HostedSessionSnapshot['phase']; readonly workspace?: SessionWorkspace; readonly claudeSessionId?: string }): HostedHandle {
  const snapshot = {
    sessionKey: overrides.sessionKey as SessionKey,
    claudeSessionId: overrides.claudeSessionId ?? null,
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

function registryOf(...handles: HostedHandle[]) {
  const registry = createHandleRegistry()
  for (const handle of handles) registry.set(handle.sessionKey, handle)
  return registry
}

const samePath = (a: string, b: string): boolean => a === b

describe('findAlreadyOpen', () => {
  it('finds a live handle by claudeSessionId', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo', claudeSessionId: 'abc' })
    expect(registryOf(handle).findAlreadyOpen('abc')).toBe(handle)
  })

  it('ignores an ended handle', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo', claudeSessionId: 'abc', phase: 'ended' })
    expect(registryOf(handle).findAlreadyOpen('abc')).toBeNull()
  })
})

describe('findFolderBusy', () => {
  it('finds a live, non-worktree handle in the same folder', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo' })
    expect(registryOf(handle).findFolderBusy('/repo', samePath)).toBe(handle)
  })

  it('allows a different folder', () => {
    expect(registryOf(fakeHandle({ sessionKey: 'hosted-1', cwd: '/other' })).findFolderBusy('/repo', samePath)).toBeNull()
  })

  it('allows a worktree session in the same repository root', () => {
    const handle = fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo/.claude/worktrees/session-a', workspace: WORKTREE })
    expect(registryOf(handle).findFolderBusy('/repo', samePath)).toBeNull()
  })

  it('allows an ended handle in the same folder', () => {
    expect(registryOf(fakeHandle({ sessionKey: 'hosted-1', cwd: '/repo', phase: 'ended' })).findFolderBusy('/repo', samePath)).toBeNull()
  })
})
