import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { NeedsYouItem } from '@/types/board'
import type { SessionKey } from '@/types/hosting'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/renderer/router/navigation', () => ({ openSession: navigate }))
vi.mock('@/renderer/gate/controller', () => ({ openReviewDialog: vi.fn() }))
vi.mock('@/renderer/decision/controller', () => ({ openDecision: vi.fn() }))
vi.mock('@/renderer/needs-you/allow-dialog', () => ({ openAllowDialog: vi.fn() }))
vi.mock('@/renderer/needs-you/restart-dialog', () => ({ openRestartDialog: vi.fn() }))
vi.mock('@/renderer/needs-you/force-dispatch-dialog', () => ({ openForceDispatchDialog: vi.fn() }))
vi.mock('@/renderer/data/invoke', () => ({ invoke: vi.fn() }))

const { actionFor, runAction, runSecondaryAction } = await import('@/renderer/needs-you/actions')
const { invoke } = await import('@/renderer/data/invoke')
const { openDecision } = await import('@/renderer/decision/controller')
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

function usageLimit(resetsAt: string | null, ids: readonly string[] = ['a', 'b', 'c']): NeedsYouItem {
  const entries = ids.map((id, index) => ({ id, number: 38 + index }))
  return { kind: 'usage-limit', repoId: null, repo: null, number: null, title: null, url: null, ticket: null, at: null, matchedRow: null, entries, resetsAt, repoNames: new Map() } as unknown as NeedsYouItem
}

describe('actionFor — dispatch-failed', () => {
  it('opens the ticket', () => {
    const item = { kind: 'dispatch-failed', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 52, title: 't', url: 'https://github.com/o/a/issues/52', ticket: null, at: null, matchedRow: null, attempts: 2, record: {} } as unknown as NeedsYouItem
    expect(actionFor(item)).toEqual({ label: 'Open ticket', kind: 'open', disabledReason: null })
  })
})

describe('actionFor — blocked', () => {
  const blocked = (unblock: object | undefined): NeedsYouItem =>
    ({ kind: 'blocked', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 56, title: 't', url: null, ticket: null, at: null, matchedRow: { decisions: { unblock } }, row: {} }) as unknown as NeedsYouItem

  it('offers Unblock enabled when the decision is available', () => {
    expect(actionFor(blocked({ available: true, context: {} }))).toEqual({ label: 'Unblock', kind: 'unblock', disabledReason: null })
  })

  it('disables Unblock while the agent is still live', () => {
    expect(actionFor(blocked({ available: false, reason: 'agent-live' }))).toMatchObject({ label: 'Unblock', disabledReason: "This item's agent is still waiting in its session. Answer it there and it clears the block itself." })
  })
})

describe('ready-to-merge Request changes', () => {
  const readyToMerge = (revise: object): NeedsYouItem =>
    ({ kind: 'ready-to-merge', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 202, title: 't', url: null, ticket: null, at: null, matchedRow: null, row: { decisions: { revise }, stageLabel: { key: 'approved' } } }) as unknown as NeedsYouItem
  const context = { cyclesUsed: 1, cap: 5 }

  beforeEach(() => {
    vi.mocked(openDecision).mockReset()
  })

  it('offers Request changes beside Open PR when revise is available', () => {
    expect(actionFor(readyToMerge({ available: true, context }))).toEqual({ label: 'Open PR', kind: 'open', disabledReason: null, secondaryLabel: 'Request changes', secondaryDisabledReason: null })
  })

  it('disables Request changes with the cap copy at the review cycle cap', () => {
    const action = actionFor(readyToMerge({ available: false, reason: 'cycle-cap' }))
    expect(action).toMatchObject({ secondaryLabel: 'Request changes' })
    expect(action.secondaryDisabledReason).toContain('used all its review cycles')
  })

  it('reuses the ownership copy when the pull request is not the viewer’s', () => {
    const action = actionFor(readyToMerge({ available: false, reason: 'not-owned' }))
    expect(action).toMatchObject({ secondaryLabel: 'Request changes' })
    expect(action.secondaryDisabledReason).toContain('Someone else owns this item')
  })

  it('leaves the button out when revise does not apply', () => {
    expect(actionFor(readyToMerge({ available: false, reason: 'not-applicable' }))).toEqual({ label: 'Open PR', kind: 'open', disabledReason: null })
  })

  it('opens the revise dialog from the secondary action', () => {
    runSecondaryAction(readyToMerge({ available: true, context }), { onToast: vi.fn() })
    expect(openDecision).toHaveBeenCalledWith({ repoId: 'repo-a', number: 202, decision: 'revise', expectedStage: 'approved', context })
  })

  it('does nothing from the secondary action when revise is unavailable', () => {
    runSecondaryAction(readyToMerge({ available: false, reason: 'cycle-cap' }), { onToast: vi.fn() })
    expect(openDecision).not.toHaveBeenCalled()
  })
})

describe('held cycle-cap row', () => {
  const heldCap = (grant: object | undefined): NeedsYouItem =>
    ({ kind: 'held', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 35, title: 't', url: 'https://github.com/o/a/pull/35', ticket: null, at: null, matchedRow: grant === undefined ? null : { decisions: { grant }, stageLabel: { key: 'needsRevision' } }, held: { reason: 'cycle-cap' } }) as unknown as NeedsYouItem
  const context = { cyclesUsed: 5, cap: 5 }

  beforeEach(() => {
    vi.mocked(openDecision).mockReset()
  })

  it('offers Grant one more cycle with Open PR beside it', () => {
    expect(actionFor(heldCap({ available: true, context }))).toMatchObject({ kind: 'grant', disabledReason: null, secondaryDisabledReason: null })
  })

  it('keeps Grant disabled with a refusal reason, never swapping to another action', () => {
    for (const reason of ['not-owned', 'agent-live']) {
      const action = actionFor(heldCap({ available: false, reason }))
      expect(action.kind).toBe('grant')
      expect(action.disabledReason).not.toBeNull()
    }
  })

  it('disables Grant when no row matched', () => {
    const action = actionFor(heldCap(undefined))
    expect(action.kind).toBe('grant')
    expect(action.disabledReason).not.toBeNull()
  })

  it('opens the grant dialog from the primary action', () => {
    runAction(heldCap({ available: true, context }), { onToast: vi.fn() })
    expect(openDecision).toHaveBeenCalledWith({ repoId: 'repo-a', number: 35, decision: 'grant', expectedStage: 'needsRevision', context })
  })

  it('opens the PR from the secondary action', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    runSecondaryAction(heldCap({ available: true, context }), { onToast: vi.fn() })
    expect(open).toHaveBeenCalledWith('https://github.com/o/a/pull/35', '_blank')
    vi.unstubAllGlobals()
  })
})

function stageInterrupted(reason: string): NeedsYouItem {
  const interrupted = { id: 'e1', agent: 'revise', reason, claudeSessionId: 'c1', worktree: { path: '/wt/revise-593', branch: 'b', baseSha: 's' } }
  return { kind: 'stage-interrupted', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 593, title: 't', url: null, ticket: null, at: null, matchedRow: null, interrupted } as unknown as NeedsYouItem
}

describe('actionFor — stage-interrupted', () => {
  it('offers only Copy path for a cleanup-failed entry', () => {
    expect(actionFor(stageInterrupted('cleanup-failed'))).toEqual({ label: 'Copy path', kind: 'copy-path', disabledReason: null })
  })

  it('still offers Resume with Restart for a crash', () => {
    expect(actionFor(stageInterrupted('crash'))).toMatchObject({ label: 'Resume', kind: 'resume', secondaryLabel: 'Restart' })
  })
})

describe('runAction — cleanup-failed Copy path', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    writeText.mockReset()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
  })

  it('copies the worktree path and toasts', async () => {
    writeText.mockResolvedValue(undefined)
    const toasts: string[] = []
    runAction(stageInterrupted('cleanup-failed'), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(['Copied the worktree path for #593.']))
    expect(writeText).toHaveBeenCalledWith('/wt/revise-593')
  })

  it('toasts the path when the clipboard write is rejected', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const toasts: string[] = []
    runAction(stageInterrupted('cleanup-failed'), { onToast: (m) => toasts.push(m) })
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't copy the path. It's /wt/revise-593."]))
    errors.mockRestore()
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
  // A block body: vitest runs a function a hook returns as its cleanup, and mockReset returns the mock itself.
  beforeEach(() => {
    invokeMock.mockReset()
  })

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
