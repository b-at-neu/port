import { describe, expect, it } from 'vitest'
import { applySnapshot, EMPTY_QUEUE, ordered, pendingPermissionsOf } from '@/renderer/permission/queue'
import { sessionSnapshot } from '../../../support/session-snapshot'
import type { HostedSessionSnapshot, PendingPermission, SessionKey } from '@/types/hosting'

function permission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    permissionId: 'perm-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    title: null,
    displayName: null,
    description: null,
    decisionReason: null,
    blockedPath: null,
    protectedPath: null,
    agentId: null,
    requestedAt: '2026-01-01T00:00:00.000Z',
    sessionGrant: null,
    interaction: null,
    ...overrides,
  }
}

function session(key: string, ...pending: PendingPermission[]): HostedSessionSnapshot {
  return sessionSnapshot({ sessionKey: key as SessionKey, pendingPermissions: pending })
}

const QUESTION = { kind: 'question', questions: [] } as const
const PLAN = { kind: 'plan', plan: null } as const

describe('applySnapshot', () => {
  it.each([
    ['adds a session with pending permissions', [session('s1', permission())], ['perm-1']],
    ['replaces a session wholesale', [session('s1', permission()), session('s1', permission({ permissionId: 'perm-2' }))], ['perm-2']],
    ['clears a session whose list is empty', [session('s1', permission()), session('s1')], []],
    ['leaves another session alone', [session('s1', permission()), session('s2', permission({ permissionId: 'perm-2' })), session('s2')], ['perm-1']],
  ])('%s', (_name, snapshots, expected) => {
    const queue = snapshots.reduce(applySnapshot, EMPTY_QUEUE)
    expect(ordered(queue).map((item) => item.permission.permissionId)).toEqual(expected)
  })
})

describe('pendingPermissionsOf', () => {
  it.each([
    ['an empty list', [], [], 0],
    ['one prompt', [session('s1', permission())], ['perm-1'], 1],
    ['an interaction prompt, counted but not listed', [session('s1', permission({ interaction: QUESTION }), permission({ permissionId: 'perm-2' }))], ['perm-2'], 2],
    ['two sessions, oldest first', [session('s1', permission({ permissionId: 'later', requestedAt: '2026-01-01T00:00:02.000Z' })), session('s2', permission({ permissionId: 'earlier', requestedAt: '2026-01-01T00:00:01.000Z' }))], ['earlier', 'later'], 2],
    ['a tie on requestedAt broken by permissionId', [session('s1', permission({ permissionId: 'b' })), session('s2', permission({ permissionId: 'a' }))], ['a', 'b'], 2],
    ['interaction cards across sessions', [session('s1', permission({ interaction: QUESTION })), session('s2', permission({ interaction: PLAN }))], [], 2],
  ])('%s', (_name, sessions, ids, waiting) => {
    const result = pendingPermissionsOf(sessions)
    expect(result.items.map((item) => item.permission.permissionId)).toEqual(ids)
    expect(result.waiting).toBe(waiting)
  })

  it('carries the session identity alongside each prompt', () => {
    const [item] = pendingPermissionsOf([sessionSnapshot({ sessionKey: 's1' as SessionKey, title: 'Fix', pendingPermissions: [permission()] })]).items
    expect(item).toMatchObject({ sessionKey: 's1', repoId: 'repo-a', title: 'Fix', origin: { kind: 'fresh' } })
  })
})
