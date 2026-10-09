import { describe, expect, it, vi } from 'vitest'
import { createPermissionStore } from './store'
import type { PermissionStoreDeps } from './store'
import type { HostedSessionSnapshot, PermissionDecision, SessionKey } from '../../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../../shared/hosting/controls'
import type { RepoId } from '../../../shared/repos'

const KEY = 'hosted-1' as SessionKey

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function snapshotWith(permissionIds: readonly string[]): HostedSessionSnapshot {
  return {
    sessionKey: KEY,
    claudeSessionId: 'c1',
    repoId: 'r1' as RepoId,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'streaming',
    origin: { kind: 'fresh' },
    startedAt: new Date().toISOString(),
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: permissionIds.map((id) => ({
      permissionId: id,
      toolName: 'Bash',
      input: {},
      title: null,
      displayName: null,
      description: null,
      decisionReason: null,
      blockedPath: null,
      agentId: null,
      requestedAt: new Date().toISOString(),
      sessionGrant: null,
      interaction: null,
    })),
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: null,
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
  }
}

function fakeDeps(overrides: Partial<PermissionStoreDeps> = {}): PermissionStoreDeps & { statusListener: (snapshot: HostedSessionSnapshot) => void } {
  let statusListener: (snapshot: HostedSessionSnapshot) => void = () => {}
  const deps: PermissionStoreDeps = {
    answerPermission: vi.fn().mockResolvedValue({ ok: true }),
    sessionList: vi.fn().mockResolvedValue([]),
    subscribeSessionStatus: (listener) => {
      statusListener = listener
      return () => {}
    },
    now: () => 0,
    setDocumentTitle: vi.fn(),
    ...overrides,
  }
  return { ...deps, get statusListener() { return statusListener } }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createPermissionStore', () => {
  it('is not armed immediately, then arms after the delay elapses', async () => {
    let now = 1000
    const deps = fakeDeps({ sessionList: vi.fn().mockResolvedValue([snapshotWith(['p1'])]), now: () => now })
    const store = createPermissionStore(deps)
    store.subscribe(() => {})
    await flush()

    expect(store.getSnapshot().armed).toBe(false)
    now += 600
    expect(store.getSnapshot().armed).toBe(false) // a stale snapshot never recomputes on its own

    deps.statusListener(snapshotWith(['p1']))
    expect(store.getSnapshot().armed).toBe(true)
  })

  it('prunes a draft message once its permission leaves the queue', async () => {
    const deps = fakeDeps({ sessionList: vi.fn().mockResolvedValue([snapshotWith(['p1', 'p2'])]) })
    const store = createPermissionStore(deps)
    store.subscribe(() => {})
    await flush()

    store.setMessage('p1', 'because')
    deps.statusListener(snapshotWith(['p1', 'p2'])) // an unrelated push recomputes the snapshot
    expect(store.getSnapshot().message).toBe('because')

    deps.statusListener(snapshotWith(['p2'])) // p1 is withdrawn
    expect(store.getSnapshot().current?.permission.permissionId).toBe('p2')

    deps.statusListener(snapshotWith(['p1', 'p2'])) // a new request reusing id p1 starts with a clean draft
    expect(store.getSnapshot().message).toBe('')
  })

  it('clears a stale sending/error state once its permission leaves the queue', async () => {
    const deps = fakeDeps({ sessionList: vi.fn().mockResolvedValue([snapshotWith(['p1', 'p2'])]), answerPermission: vi.fn().mockRejectedValue(new Error('down')) })
    const store = createPermissionStore(deps)
    store.subscribe(() => {})
    await flush()

    await store.answer({ sessionKey: KEY, repoId: 'r1' as RepoId, folder: '/repo', title: null, origin: { kind: 'fresh' }, startedAt: 't', permission: snapshotWith(['p1']).pendingPermissions[0]! }, 'deny' satisfies PermissionDecision)
    expect(store.getSnapshot().current?.permission.permissionId).toBe('p1')
    expect(store.getSnapshot().error).not.toBeNull()

    deps.statusListener(snapshotWith(['p2'])) // p1 is gone
    expect(store.getSnapshot().current?.permission.permissionId).toBe('p2')
    expect(store.getSnapshot().error).toBeNull()
  })
})
