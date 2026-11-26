import { describe, expect, it, vi } from 'vitest'
import { createNotifier, notificationFor } from '@/main/sessions/hosting/notify'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { DEFAULT_NOTIFICATION_PREFS } from '@/types/settings'
import type { NotificationPrefs } from '@/types/settings'
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import type { RepoId } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'
import type { SessionWorkspace } from '@/types/workspace'
import type { Repos } from '@/main/repos'
import { readyEntry } from '../../../../support/repo-config'

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
    capabilities: { kind: 'pending' },
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
    const title = notificationFor(previous, next, 'widgets')?.title
    expect(title).toContain('widgets')
    expect(title).toContain('#46 Show the last sync time')
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
    const completedBody = notificationFor(previous, completed, 'widgets')?.body

    const crashed = snapshot({ phase: 'ended', end: { reason: 'exit-nonzero', exitCode: 1, signal: null, message: null, diagnosis: null } })
    expect(notificationFor(previous, crashed, 'widgets')?.body).not.toBe(completedBody)
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
  const defaultPrefs = (): Promise<NotificationPrefs> => Promise.resolve(DEFAULT_NOTIFICATION_PREFS)
  const finished = (notifier: ReturnType<typeof createNotifier>): void => {
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
  }

  function harness(options: { readonly focused?: () => boolean; readonly prefs?: () => Promise<NotificationPrefs>; readonly list?: Repos['list'] } = {}) {
    const shown: { title: string; body: string }[] = []
    const clicks: (() => void)[] = []
    const emitted: unknown[] = []
    const list = vi.fn(options.list ?? (() => Promise.resolve({ ok: true as const, repositories: [readyEntry({ id: 'repo-1' as RepoId }, { repo: 'o/widgets' })] })))
    const notifier = createNotifier(
      {
        notify: {
          focused: options.focused ?? (() => false),
          show: (notice, onClick) => {
            shown.push(notice)
            clicks.push(onClick)
          },
        },
        repos: { list },
        emit: (_event, payload) => {
          emitted.push(payload)
        },
      },
      options.prefs ?? defaultPrefs,
    )
    return { notifier, shown, clicks, emitted, list }
  }

  it('fires once when unfocused, never while focused, and never replays after refocus', async () => {
    let focused = true
    const { notifier, shown, list } = harness({ focused: () => focused })
    finished(notifier)
    await Promise.resolve()
    expect(shown).toEqual([])
    expect(list).not.toHaveBeenCalled()

    focused = false
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(shown).toHaveLength(1))

    focused = true
    notifier.observe(snapshot({ phase: 'ready' }))
    focused = false
    notifier.observe(snapshot({ phase: 'ready' }))
    expect(shown).toHaveLength(1)
  })

  it('notifies the end of a session once, whatever its baseline was', async () => {
    const { notifier, shown } = harness()
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ended', end: { reason: 'completed', exitCode: 0, signal: null, message: null, diagnosis: null } }))
    await vi.waitFor(() => expect(shown).toHaveLength(1))
  })

  it('looks the label up only when something fires, and names the repository in the title', async () => {
    const { notifier, shown, list } = harness()
    const only = snapshot({ phase: 'streaming' })
    notifier.observe(only)
    notifier.observe(only)
    expect(list).not.toHaveBeenCalled()

    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(shown[0]?.title).toContain('o/widgets')
  })

  it('falls back to the folder basename, never null, when the lookup rejects', async () => {
    const { notifier, shown } = harness({ list: () => Promise.reject(new Error('lookup failed')) })
    finished(notifier)
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(shown[0]?.title).toContain('repo')
    expect(shown[0]?.title).not.toContain('null')
  })

  it('shows nothing while session notifications are off, yet keeps its baseline so turning them on fires only the next transition', async () => {
    let sessions = false
    const { notifier, shown, list } = harness({ prefs: () => Promise.resolve({ needsYou: true, sessions }) })
    finished(notifier)
    await vi.waitFor(() => expect(list).not.toHaveBeenCalled())
    expect(shown).toEqual([])

    sessions = true
    notifier.observe(snapshot({ phase: 'ready' }))
    notifier.observe(snapshot({ phase: 'streaming' }))
    notifier.observe(snapshot({ phase: 'ready' }))
    await vi.waitFor(() => expect(shown).toHaveLength(1))
  })

  it('fires, failing toward on, when the preference read rejects', async () => {
    const { notifier, shown } = harness({ prefs: () => Promise.reject(new Error('unreadable')) })
    finished(notifier)
    await vi.waitFor(() => expect(shown).toHaveLength(1))
  })

  it('a click on a session notification opens that session', async () => {
    const { notifier, clicks, emitted } = harness()
    finished(notifier)
    await vi.waitFor(() => expect(clicks).toHaveLength(1))
    clicks[0]?.()
    expect(emitted).toEqual([{ kind: 'open-session', sessionKey: 'hosted-1' }])
  })

  it.each([
    { name: 'shows a needs-you notice when unfocused and on', focused: false, needsYou: true, shown: 1 },
    { name: 'shows nothing while a window is focused', focused: true, needsYou: true, shown: 0 },
    { name: 'shows nothing while needs-you notifications are off', focused: false, needsYou: false, shown: 0 },
  ])('showNeedsYou $name', async ({ focused, needsYou, shown: expected }) => {
    const { notifier, shown, clicks, emitted } = harness({ focused: () => focused, prefs: () => Promise.resolve({ needsYou, sessions: true }) })
    notifier.showNeedsYou({ title: 'Needs you', body: 'Approve', focus: 'item-7' })
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toHaveLength(expected)
    if (expected === 1) {
      clicks[0]?.()
      expect(emitted).toEqual([{ kind: 'open-needs-you', focus: 'item-7' }])
    }
  })
})
