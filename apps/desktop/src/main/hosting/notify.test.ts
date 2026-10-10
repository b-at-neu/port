import { describe, expect, it, vi } from 'vitest'
import { createNotifier, notificationFor } from './notify'
import type { HostedSessionSnapshot } from '../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../shared/hosting/controls'
import type { RepoId } from '../../shared/repos'
import type { SessionKey } from '../../shared/hosting/types'
import type { SessionWorkspace } from '../../shared/workspace/types'

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }
const TEST_WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'c1',
    repoId: 'repo-1' as RepoId,
    workspace: TEST_WORKSPACE,
    phase: 'streaming',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00.000Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: 'Fix the thing',
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
    usage: null,
    backgroundTasks: [],
    ...overrides,
  }
}

describe('notificationFor', () => {
  it('never notifies on the first snapshot of a session', () => {
    expect(notificationFor(null, snapshot(), 'widgets')).toBeNull()
  })

  it('notifies needs-you for a new pending permission', () => {
    const previous = snapshot({ pendingPermissions: [] })
    const next = snapshot({ pendingPermissions: [{ permissionId: 'p1', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, agentId: null, requestedAt: 't', sessionGrant: null, interaction: null }] })
    const result = notificationFor(previous, next, 'widgets')
    expect(result?.kind).toBe('needs-you')
    expect(result?.body).toContain('Bash')
  })

  it('notifies finished when streaming ends with no pending permissions', () => {
    const previous = snapshot({ phase: 'streaming' })
    const next = snapshot({ phase: 'ready' })
    expect(notificationFor(previous, next, 'widgets')?.kind).toBe('finished')
  })

  it('does not notify finished when a permission is still pending', () => {
    const permission = { permissionId: 'p1', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, agentId: null, requestedAt: 't', sessionGrant: null, interaction: null }
    const previous = snapshot({ phase: 'streaming', pendingPermissions: [permission] })
    const next = snapshot({ phase: 'ready', pendingPermissions: [permission] })
    expect(notificationFor(previous, next, 'widgets')).toBeNull()
  })

  it('notifies ended on the ended transition, with the completed/unexpected wording', () => {
    const previous = snapshot({ phase: 'streaming' })
    const completed = snapshot({ phase: 'ended', end: { reason: 'completed', exitCode: 0, signal: null, message: null, diagnosis: null } })
    expect(notificationFor(previous, completed, 'widgets')?.body).toBe('The session ended.')

    const crashed = snapshot({ phase: 'ended', end: { reason: 'exit-nonzero', exitCode: 1, signal: null, message: null, diagnosis: null } })
    expect(notificationFor(previous, crashed, 'widgets')?.body).toContain('unexpectedly')
  })

  it('returns null with no transition', () => {
    const previous = snapshot({ phase: 'streaming' })
    expect(notificationFor(previous, snapshot({ phase: 'streaming' }), 'widgets')).toBeNull()
  })
})

describe('createNotifier', () => {
  it('fires only when the app is unfocused', () => {
    const show = vi.fn()
    const notifier = createNotifier({ isAppFocused: () => true, show, repoLabel: () => 'widgets' })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    expect(show).not.toHaveBeenCalled()
  })

  it('fires once when unfocused, and never replays after refocus', () => {
    let focused = false
    const show = vi.fn()
    const notifier = createNotifier({ isAppFocused: () => focused, show, repoLabel: () => 'widgets' })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    expect(show).toHaveBeenCalledTimes(1)

    focused = true
    notifier.observe(snapshot({ phase: 'ready' }))
    focused = false
    notifier.observe(snapshot({ phase: 'ready' }))
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('drops an ended session from its baseline, so a stale previous never lingers', () => {
    const show = vi.fn()
    const notifier = createNotifier({ isAppFocused: () => false, show, repoLabel: () => 'widgets' })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ended', end: { reason: 'completed', exitCode: 0, signal: null, message: null, diagnosis: null } }))
    expect(show).toHaveBeenCalledTimes(1)
  })
})
