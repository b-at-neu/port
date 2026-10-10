import { describe, expect, it } from 'vitest'
import { applySnapshot, EMPTY_QUEUE, interactionCount, ordered, seed } from './queue'
import type { HostedSessionSnapshot, PendingPermission, SessionKey } from '../../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../../shared/hosting/controls'
import type { RepoId } from '../../../shared/repos'

const REPO_A = 'repo-a' as RepoId
const REPO_B = 'repo-b' as RepoId

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

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
    agentId: null,
    requestedAt: '2026-01-01T00:00:00.000Z',
    sessionGrant: null,
    interaction: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    repoId: REPO_A,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'streaming',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00.000Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: null,
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
    usage: null,
    ...overrides,
  }
}

describe('applySnapshot', () => {
  it('adds a session entry when the snapshot carries pending permissions', () => {
    const queue = applySnapshot(EMPTY_QUEUE, snapshot({ pendingPermissions: [permission()] }))
    expect(ordered(queue)).toHaveLength(1)
  })

  it('replaces that session entry wholesale rather than merging', () => {
    let queue = applySnapshot(EMPTY_QUEUE, snapshot({ pendingPermissions: [permission({ permissionId: 'perm-1' })] }))
    queue = applySnapshot(queue, snapshot({ pendingPermissions: [permission({ permissionId: 'perm-2' })] }))
    const items = ordered(queue)
    expect(items).toHaveLength(1)
    expect(items[0]?.permission.permissionId).toBe('perm-2')
  })

  it('an empty pendingPermissions list clears that session (an ended snapshot, or a withdrawn prompt)', () => {
    let queue = applySnapshot(EMPTY_QUEUE, snapshot({ pendingPermissions: [permission()] }))
    queue = applySnapshot(queue, snapshot({ pendingPermissions: [] }))
    expect(ordered(queue)).toEqual([])
  })

  it('never touches another session entry', () => {
    let queue = applySnapshot(EMPTY_QUEUE, snapshot({ sessionKey: 'hosted-1' as SessionKey, pendingPermissions: [permission()] }))
    queue = applySnapshot(queue, snapshot({ sessionKey: 'hosted-2' as SessionKey, repoId: REPO_B, pendingPermissions: [permission({ permissionId: 'perm-2' })] }))
    expect(ordered(queue)).toHaveLength(2)
    queue = applySnapshot(queue, snapshot({ sessionKey: 'hosted-2' as SessionKey, pendingPermissions: [] }))
    const items = ordered(queue)
    expect(items).toHaveLength(1)
    expect(items[0]?.sessionKey).toBe('hosted-1')
  })
})

describe('seed', () => {
  it('folds a list of snapshots the same way applySnapshot would, one at a time', () => {
    const snapshots = [snapshot({ sessionKey: 'hosted-1' as SessionKey, pendingPermissions: [permission()] }), snapshot({ sessionKey: 'hosted-2' as SessionKey, pendingPermissions: [] })]
    const queue = seed(snapshots)
    expect(ordered(queue)).toHaveLength(1)
  })
})

describe('ordered', () => {
  it('sorts oldest requestedAt first across sessions', () => {
    let queue = applySnapshot(EMPTY_QUEUE, snapshot({ sessionKey: 'hosted-1' as SessionKey, pendingPermissions: [permission({ permissionId: 'later', requestedAt: '2026-01-01T00:00:02.000Z' })] }))
    queue = applySnapshot(queue, snapshot({ sessionKey: 'hosted-2' as SessionKey, pendingPermissions: [permission({ permissionId: 'earlier', requestedAt: '2026-01-01T00:00:01.000Z' })] }))
    const items = ordered(queue)
    expect(items.map((i) => i.permission.permissionId)).toEqual(['earlier', 'later'])
  })

  it('breaks a tie on requestedAt with permissionId, stably', () => {
    let queue = applySnapshot(EMPTY_QUEUE, snapshot({ sessionKey: 'hosted-1' as SessionKey, pendingPermissions: [permission({ permissionId: 'b', requestedAt: '2026-01-01T00:00:00.000Z' })] }))
    queue = applySnapshot(queue, snapshot({ sessionKey: 'hosted-2' as SessionKey, pendingPermissions: [permission({ permissionId: 'a', requestedAt: '2026-01-01T00:00:00.000Z' })] }))
    const items = ordered(queue)
    expect(items.map((i) => i.permission.permissionId)).toEqual(['a', 'b'])
  })

  it('carries the session repoId alongside each queued permission', () => {
    const queue = applySnapshot(EMPTY_QUEUE, snapshot({ repoId: REPO_B, pendingPermissions: [permission()] }))
    expect(ordered(queue)[0]?.repoId).toBe(REPO_B)
  })

  it('carries the session title, origin, and startedAt alongside each queued permission', () => {
    const queue = applySnapshot(EMPTY_QUEUE, snapshot({ title: 'Fix the thing', origin: { kind: 'fresh' }, startedAt: '2026-01-01T00:00:00.000Z', pendingPermissions: [permission()] }))
    const item = ordered(queue)[0]
    expect(item?.title).toBe('Fix the thing')
    expect(item?.origin).toEqual({ kind: 'fresh' })
    expect(item?.startedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns an empty list for an empty queue', () => {
    expect(ordered(EMPTY_QUEUE)).toEqual([])
  })

  it('excludes an entry with a non-null interaction — it renders as its own card, never the generic dialog', () => {
    const queue = applySnapshot(
      EMPTY_QUEUE,
      snapshot({ pendingPermissions: [permission({ permissionId: 'question-1', interaction: { kind: 'question', questions: [] } }), permission({ permissionId: 'ordinary-1' })] }),
    )
    expect(ordered(queue).map((item) => item.permission.permissionId)).toEqual(['ordinary-1'])
  })
})

describe('interactionCount', () => {
  it('counts only entries with a non-null interaction, across sessions', () => {
    let queue = applySnapshot(EMPTY_QUEUE, snapshot({ sessionKey: 'hosted-1' as SessionKey, pendingPermissions: [permission({ permissionId: 'question-1', interaction: { kind: 'question', questions: [] } }), permission({ permissionId: 'ordinary-1' })] }))
    queue = applySnapshot(queue, snapshot({ sessionKey: 'hosted-2' as SessionKey, pendingPermissions: [permission({ permissionId: 'plan-1', interaction: { kind: 'plan', plan: null } })] }))
    expect(interactionCount(queue)).toBe(2)
  })

  it('is zero for an empty queue', () => {
    expect(interactionCount(EMPTY_QUEUE)).toBe(0)
  })
})
