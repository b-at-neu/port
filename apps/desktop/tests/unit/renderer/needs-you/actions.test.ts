import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { NeedsYouItem } from '@/types/board'
import type { SessionKey } from '@/types/hosting'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/renderer/router/router', () => ({ router: { navigate } }))
vi.mock('@/renderer/gate/controller', () => ({ openReviewDialog: vi.fn() }))
vi.mock('@/renderer/decision/controller', () => ({ openDecision: vi.fn() }))
vi.mock('@/renderer/needs-you/allow-dialog', () => ({ openAllowDialog: vi.fn() }))
vi.mock('@/renderer/needs-you/restart-dialog', () => ({ openRestartDialog: vi.fn() }))
vi.mock('@/renderer/needs-you/force-dispatch-dialog', () => ({ openForceDispatchDialog: vi.fn() }))
vi.mock('@/renderer/data/invoke', () => ({ invoke: vi.fn() }))

const { actionFor, runAction, runSecondaryAction } = await import('@/renderer/needs-you/actions')
const { invoke } = await import('@/renderer/data/invoke')
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

function usageLimit(resetsAt: string | null, ids: readonly string[] = ['a', 'b', 'c']): NeedsYouItem {
  const entries = ids.map((id, index) => ({ id, number: 38 + index }))
  return { kind: 'usage-limit', repoId: null, repo: null, number: null, title: null, url: null, ticket: null, at: null, matchedRow: null, entries, resetsAt, repoNames: new Map() } as unknown as NeedsYouItem
}

function stageBlocked(): NeedsYouItem {
  return { kind: 'stage-blocked', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 51, title: 't', url: null, ticket: null, at: null, matchedRow: null, sessionKey: 'hosted-51' as SessionKey, text: 'BLOCKED: x' }
}

describe('actionFor — stage-blocked', () => {
  it('answers inline, with Open session as its secondary', () => {
    expect(actionFor(stageBlocked())).toEqual({ label: 'Unblock', kind: 'answer', disabledReason: null, secondaryLabel: 'Open session' })
  })
})

describe('actionFor — usage-limit', () => {
  const RESET = '2026-01-01T14:05:00.000Z'

  it('is Resume all, disabled with the reset time before the limit resets', () => {
    const action = actionFor(usageLimit(RESET), new Date('2026-01-01T13:00:00.000Z'))
    expect(action).toMatchObject({ label: 'Resume all', kind: 'resume-all' })
    expect(action.disabledReason).toMatch(/^The limit resets at .+\. port resumes these sessions then\.$/)
  })

  it('is enabled once the reset has passed', () => {
    expect(actionFor(usageLimit(RESET), new Date('2026-01-01T15:00:00.000Z')).disabledReason).toBeNull()
  })

  it('is enabled when the reset time is unknown', () => {
    expect(actionFor(usageLimit(null), new Date('2026-01-01T13:00:00.000Z')).disabledReason).toBeNull()
  })
})

describe('runAction — usage-limit Resume all', () => {
  const PAST = '2020-01-01T00:00:00.000Z'
  beforeEach(() => invokeMock.mockReset())

  it('resumes every entry in turn and reports one summary', async () => {
    invokeMock.mockResolvedValue({ kind: 'ok', sessionKey: 'hosted-1' })
    const toasts: string[] = []
    runAction(usageLimit(PAST), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['Resumed 3 sessions.']))
    expect(invokeMock.mock.calls.map((call: unknown[]) => call[1])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  })

  it('stops at the first full house', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'ok', sessionKey: 'hosted-1' }).mockResolvedValueOnce({ kind: 'at-capacity', limit: 4 })
    const toasts: string[] = []
    runAction(usageLimit(PAST), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['Resumed 1 of 3. All 4 session slots are busy.']))
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('stops at the first failure and names its ticket', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'start-failed', message: 'runtime problem' })
    const toasts: string[] = []
    runAction(usageLimit(PAST), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't resume #38: runtime problem."]))
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('skips an entry that is no longer tracked without counting it', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'unknown-stage' }).mockResolvedValueOnce({ kind: 'ok', sessionKey: 'hosted-1' })
    const toasts: string[] = []
    runAction(usageLimit(PAST, ['a', 'b']), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['Resumed 1 session.']))
  })

  it('does nothing before the reset', () => {
    const toasts: string[] = []
    runAction(usageLimit('2999-01-01T00:00:00.000Z'), { onToast: (m) => toasts.push(m) })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(toasts).toEqual([])
  })
})

function stageApproval(): NeedsYouItem {
  return { kind: 'stage-approval', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 466, title: 't', url: null, ticket: null, at: null, matchedRow: null, sessionKey: 'hosted-466' as SessionKey, permissionId: 'perm-1', agent: 'impl', toolName: 'Edit', path: '.claude/settings.json' }
}

describe('actionFor — stage-approval', () => {
  it('approves the edit, with Deny as its secondary', () => {
    expect(actionFor(stageApproval())).toEqual({ label: 'Approve edit', kind: 'approve', disabledReason: null, secondaryLabel: 'Deny' })
  })
})

describe('stage-approval answers', () => {
  beforeEach(() => invokeMock.mockReset())

  it('Approve edit allows the edit once and toasts', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const toasts: string[] = []
    runAction(stageApproval(), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['Approved the edit to .claude/settings.json.']))
    expect(invokeMock).toHaveBeenCalledWith('session:permission:answer', { sessionKey: 'hosted-466', permissionId: 'perm-1', decision: 'allow-once', message: null })
  })

  it('Deny sends the deny message and toasts', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const toasts: string[] = []
    runSecondaryAction(stageApproval(), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['Denied the edit to .claude/settings.json.']))
    expect(invokeMock).toHaveBeenCalledWith('session:permission:answer', {
      sessionKey: 'hosted-466',
      permissionId: 'perm-1',
      decision: 'deny',
      message: 'The operator denied this protected edit. Carry on without it, or end with BLOCKED: naming the file.',
    })
  })

  it('reports an edit that is no longer waiting', async () => {
    invokeMock.mockResolvedValue({ ok: false, kind: 'unknown-permission' })
    const toasts: string[] = []
    runAction(stageApproval(), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['That edit is no longer waiting — the session moved on.']))
  })

  it('reports an unreachable main process', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'))
    const toasts: string[] = []
    runAction(stageApproval(), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't reach the main process. Nothing was answered."]))
  })
})

describe('runSecondaryAction — stage-blocked', () => {
  beforeEach(() => navigate.mockClear())

  it('opens the live session', () => {
    runSecondaryAction(stageBlocked(), { onToast: () => undefined })
    expect(navigate).toHaveBeenCalledWith({ to: '/session', search: { key: 'hosted-51' } })
  })
})
