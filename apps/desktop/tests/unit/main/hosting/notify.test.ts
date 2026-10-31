import { describe, expect, it, vi } from 'vitest'
import { createNotifier, notificationFor } from '@/main/hosting/notify'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import type { RepoId } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'
import type { SessionWorkspace } from '@/types/workspace'

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
    stage: null,
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
    lastResult: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

describe('notificationFor', () => {
  it('never notifies on the first snapshot of a session', () => {
    expect(notificationFor(null, snapshot(), 'widgets')).toBeNull()
  })

  it('notifies needs-you for a new pending permission', () => {
    const previous = snapshot({ pendingPermissions: [] })
    const next = snapshot({ pendingPermissions: [{ permissionId: 'p1', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, protectedPath: null, agentId: null, requestedAt: 't', sessionGrant: null, interaction: null }] })
    const result = notificationFor(previous, next, 'widgets')
    expect(result?.kind).toBe('needs-you')
    expect(result?.body).toContain('Bash')
  })

  it("names a stage session's ticket in the notification title", () => {
    const stage = { agent: 'review', number: 47, kind: 'pull-request', trigger: 'readyForReview' } as const
    const permission = { permissionId: 'p1', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, protectedPath: null, agentId: null, requestedAt: 't', sessionGrant: null, interaction: null }
    const previous = snapshot({ stage, title: '#46 Show the last sync time' })
    const next = snapshot({ stage, title: '#46 Show the last sync time', pendingPermissions: [permission] })
    expect(notificationFor(previous, next, 'widgets')?.title).toBe('widgets · #46 Show the last sync time')
  })

  it('notifies finished when streaming ends with no pending permissions', () => {
    const previous = snapshot({ phase: 'streaming' })
    const next = snapshot({ phase: 'ready' })
    expect(notificationFor(previous, next, 'widgets')?.kind).toBe('finished')
  })

  it('does not notify finished when a permission is still pending', () => {
    const permission = { permissionId: 'p1', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, protectedPath: null, agentId: null, requestedAt: 't', sessionGrant: null, interaction: null }
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

describe('notificationFor — stage sessions', () => {
  const stage = { agent: 'review', number: 47, kind: 'pull-request', trigger: 'readyForReview' } as const
  const permission = { permissionId: 'p1', toolName: 'Edit', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, protectedPath: null, agentId: null, requestedAt: 't', sessionGrant: null, interaction: null }
  const question = { ...permission, toolName: 'AskUserQuestion', interaction: { kind: 'question' } } as unknown as typeof permission
  const plan = { ...permission, toolName: 'ExitPlanMode', interaction: { kind: 'plan' } } as unknown as typeof permission

  it('does not notify when a stage session finishes a turn', () => {
    expect(notificationFor(snapshot({ stage, phase: 'streaming' }), snapshot({ stage, phase: 'ready' }), 'widgets')).toBeNull()
  })

  it.each([
    ['completed', { reason: 'completed', exitCode: 0, signal: null, message: null, diagnosis: null }],
    ['unexpected', { reason: 'exit-nonzero', exitCode: 1, signal: null, message: null, diagnosis: null }],
  ] as const)('does not notify when a stage session ends (%s)', (_name, end) => {
    expect(notificationFor(snapshot({ stage, phase: 'ready' }), snapshot({ stage, phase: 'ended', end }), 'widgets')).toBeNull()
  })

  it('does not notify for a stage question, which Needs you already lists', () => {
    expect(notificationFor(snapshot({ stage }), snapshot({ stage, pendingPermissions: [question] }), 'widgets')).toBeNull()
  })

  it('does not notify for a protected stage edit, which Needs you lists as an approval', () => {
    const protectedEdit = { ...permission, protectedPath: '.claude/settings.json' }
    expect(notificationFor(snapshot({ stage }), snapshot({ stage, pendingPermissions: [protectedEdit] }), 'widgets')).toBeNull()
  })

  it('still notifies an operator session for the same protected-path permission', () => {
    const protectedEdit = { ...permission, protectedPath: '.claude/settings.json' }
    expect(notificationFor(snapshot(), snapshot({ pendingPermissions: [protectedEdit] }), 'widgets')?.kind).toBe('needs-you')
  })

  it('still notifies for a stage permission that has no Needs you row', () => {
    expect(notificationFor(snapshot({ stage }), snapshot({ stage, pendingPermissions: [permission] }), 'widgets')?.kind).toBe('needs-you')
    expect(notificationFor(snapshot({ stage }), snapshot({ stage, pendingPermissions: [plan] }), 'widgets')?.kind).toBe('needs-you')
  })

  it('notifies for a stage permission that arrives beside an already-pending question', () => {
    const previous = snapshot({ stage, pendingPermissions: [question] })
    const next = snapshot({ stage, pendingPermissions: [question, { ...permission, permissionId: 'p2' }] })
    expect(notificationFor(previous, next, 'widgets')?.kind).toBe('needs-you')
  })

  it('keeps a manual session notifying for a question, a finish and an end', () => {
    expect(notificationFor(snapshot(), snapshot({ pendingPermissions: [question] }), 'widgets')?.kind).toBe('needs-you')
    expect(notificationFor(snapshot({ phase: 'streaming' }), snapshot({ phase: 'ready' }), 'widgets')?.kind).toBe('finished')
    expect(notificationFor(snapshot({ phase: 'ready' }), snapshot({ phase: 'ended', end: { reason: 'completed', exitCode: 0, signal: null, message: null, diagnosis: null } }), 'widgets')?.kind).toBe('ended')
  })
})

describe('createNotifier', () => {
  function resolvedLabel(label: string): () => Promise<string> {
    return () => Promise.resolve(label)
  }

  it('fires only when the app is unfocused', async () => {
    const show = vi.fn<(notification: { title: string }, snapshot: HostedSessionSnapshot) => void>()
    const repoLabel = vi.fn(resolvedLabel('widgets'))
    const notifier = createNotifier({ isAppFocused: () => true, show, repoLabel })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(repoLabel).not.toHaveBeenCalled())
    expect(show).not.toHaveBeenCalled()
  })

  it('fires once when unfocused, and never replays after refocus', async () => {
    let focused = false
    const show = vi.fn<(notification: { title: string }, snapshot: HostedSessionSnapshot) => void>()
    const notifier = createNotifier({ isAppFocused: () => focused, show, repoLabel: resolvedLabel('widgets') })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))

    focused = true
    notifier.observe(snapshot({ phase: 'ready' }))
    focused = false
    notifier.observe(snapshot({ phase: 'ready' }))
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('drops an ended session from its baseline, so a stale previous never lingers', async () => {
    const show = vi.fn<(notification: { title: string }, snapshot: HostedSessionSnapshot) => void>()
    const notifier = createNotifier({ isAppFocused: () => false, show, repoLabel: resolvedLabel('widgets') })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ended', end: { reason: 'completed', exitCode: 0, signal: null, message: null, diagnosis: null } }))
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
  })

  it('never calls the label lookup when nothing fires', () => {
    const repoLabel = vi.fn(resolvedLabel('widgets'))
    const notifier = createNotifier({ isAppFocused: () => false, show: vi.fn(), repoLabel })
    const only = snapshot({ phase: 'streaming' })
    notifier.observe(only)
    notifier.observe(only)
    expect(repoLabel).not.toHaveBeenCalled()
  })

  it('uses the resolved label in the shown title', async () => {
    const show = vi.fn<(notification: { title: string }, snapshot: HostedSessionSnapshot) => void>()
    const notifier = createNotifier({ isAppFocused: () => false, show, repoLabel: resolvedLabel('widgets') })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(show.mock.calls[0]?.[0].title).toContain('widgets')
  })

  it('falls back to the folder basename, never null, when the lookup rejects', async () => {
    const show = vi.fn<(notification: { title: string }, snapshot: HostedSessionSnapshot) => void>()
    const notifier = createNotifier({ isAppFocused: () => false, show, repoLabel: () => Promise.reject(new Error('lookup failed')) })
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(show.mock.calls[0]?.[0].title).toContain('repo')
    expect(show.mock.calls[0]?.[0].title).not.toContain('null')
  })
})
