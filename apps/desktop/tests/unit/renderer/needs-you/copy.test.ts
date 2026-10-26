import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { NeedsYouItem } from '@/types/board'
import type { InterruptedStage } from '@/types/stage'
import { GROUP_NAMES, blockerSendError, blockerSentToast, dismissedToast, needsYouLeadCopy, refreshedToast, resumeAllDisabledReason, resumeAllToast, usageLimitEntryLine } from '@/renderer/needs-you/copy'

function base(overrides: Partial<NeedsYouItem> = {}): Pick<NeedsYouItem, 'repoId' | 'repo' | 'number' | 'title' | 'url' | 'ticket' | 'at' | 'matchedRow'> {
  return { repoId: 'repo-a' as RepoId, repo: 'o/a', number: 41, title: 't', url: 'https://github.com/o/a/issues/41', ticket: null, at: null, matchedRow: null, ...overrides }
}

describe('needsYouLeadCopy', () => {
  it('plan-review', () => {
    const item = { ...base(), kind: 'plan-review', row: {} as never } as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('Review the plan for #41')
  })

  it('ready-to-merge', () => {
    const item = { ...base({ number: 36 }), kind: 'ready-to-merge', row: {} as never } as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#36 is ready to merge')
  })

  it('needs-human with a reason', () => {
    const item = {
      ...base({ number: 33 }),
      kind: 'needs-human',
      matchedRow: { decisions: { unblock: { available: true, context: { reason: 'budget exceeded', cyclesUsed: 0, cap: 5, decisions: [] } } } },
      row: {} as never,
    } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('Unblock #33: budget exceeded')
  })

  it('needs-human with no reason', () => {
    const item = { ...base({ number: 33 }), kind: 'needs-human', matchedRow: null, row: {} as never } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('Unblock #33: escalated without a reason')
  })

  it('blocked', () => {
    const item = { ...base({ number: 30 }), kind: 'blocked', row: {} as never } as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('Unblock #30: an agent marked it blocked')
  })

  it('budget — escalated', () => {
    const item = { ...base({ number: 45 }), kind: 'budget', note: { kind: 'escalated', number: 45, needsHumanLabel: 'needs human', commentFailedMessage: null } } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#45 went over budget and needs you')
  })

  it('budget — escalation-failed', () => {
    const item = {
      ...base({ number: 45 }),
      kind: 'budget',
      note: { kind: 'escalation-failed', number: 45, needsHumanLabel: 'needs human', triggerLabel: 'ready for review', outcome: { kind: 'write-failed', classification: 'unknown', stderr: '', reread: null } },
    } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#45 went over budget, but the escalation write failed (write-failed)')
  })

  it('held — conflicting', () => {
    const item = { ...base({ number: 312 }), kind: 'held', held: { number: 312, kind: 'pull-request', trigger: 'readyForReview', reason: 'conflicting', contention: null, escalation: null } } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe("#312 can't be reviewed: its branch conflicts with the base branch. Refresh it.")
  })

  it('held — contended names the blocker and file count', () => {
    const item = {
      ...base({ number: 47 }),
      kind: 'held',
      held: { number: 47, kind: 'issue', trigger: 'ready', reason: 'contended', contention: { blocker: 38, blockerStage: 'impl-agent', depth: 1, paths: ['a.ts', 'b.ts'] }, escalation: null },
    } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#47 waits on #38: both change 2 files')
  })

  it('held — cycle-cap names the count and cap', () => {
    const item = {
      ...base({ number: 35 }),
      kind: 'held',
      held: { number: 35, kind: 'pull-request', trigger: 'readyForReview', reason: 'cycle-cap', contention: null, escalation: { kind: 'cycle-cap', count: 5, cap: 5 } },
    } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#35 hit the review cycle cap (5 of 5). Decide how to continue.')
  })

  it('stalled', () => {
    const item = { ...base({ number: 39 }), kind: 'stalled', claim: {} as never } as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('Retry #39: its agent stopped responding')
  })

  it('half-labelled — handback-unlabelled uses the resolved label name and the agent\'s phase name', () => {
    const item = {
      ...base({ number: 52 }),
      kind: 'half-labelled',
      matchedRow: { item: { stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }] } },
      repair: { number: 52, kind: 'issue', shape: 'handback-unlabelled', labels: ['inProgress'], agent: 'impl' },
    } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#52\'s implementing session finished, but its label is still "in progress". Check the ticket and set the right label.')
  })

  it('half-labelled — contradictory names every conflicting label', () => {
    const item = {
      ...base({ number: 52 }),
      kind: 'half-labelled',
      matchedRow: {
        item: {
          stages: [
            { key: 'planning', name: 'planning', role: 'in-flight' },
            { key: 'planReview', name: 'plan review', role: 'gate' },
          ],
        },
      },
      repair: { number: 52, kind: 'issue', shape: 'contradictory', labels: ['planning', 'planReview'], agent: null },
    } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#52 has conflicting labels: "planning", "plan review". Remove the one that\'s wrong.')
  })

  it('half-labelled — plan-missing-approved', () => {
    const item = { ...base({ number: 52 }), kind: 'half-labelled', repair: { number: 52, kind: 'issue', shape: 'plan-missing-approved', labels: ['planApproved'], agent: null } } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#52 is approved, but its body has no implementation plan. Restore the plan or move it back to "ready".')
  })

  it('half-labelled — pr-missing', () => {
    const item = { ...base({ number: 52 }), kind: 'half-labelled', repair: { number: 52, kind: 'issue', shape: 'pr-missing', labels: ['prOpened'], agent: null } } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#52 says a pull request is open, but none is. Reopen it or move the issue back.')
  })

  it('stage-blocked leads with the blocker text, without its BLOCKED: prefix', () => {
    const item = { ...base({ number: 51 }), kind: 'stage-blocked', sessionKey: 'hosted-1', text: 'The ledger export has no currency column.' } as unknown as NeedsYouItem
    expect(needsYouLeadCopy(item)).toBe('#51 is blocked: The ledger export has no currency column.')
  })
})

describe('usage-limit copy', () => {
  const RESET = '2026-01-01T14:05:00.000Z'
  const clock = new Date(RESET).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const entry = (id: string, number: number, repoId = 'repo-a') => ({ id, number, repoId: repoId as RepoId, agent: 'impl' as const })
  function limited(count: number, resetsAt: string | null): Extract<NeedsYouItem, { readonly kind: 'usage-limit' }> {
    const entries = Array.from({ length: count }, (_, i) => entry(`e${String(i)}`, 38 + i)) as unknown as Extract<NeedsYouItem, { readonly kind: 'usage-limit' }>['entries']
    return { ...base({ repoId: null, repo: null, number: null }), kind: 'usage-limit', entries, resetsAt, repoNames: new Map([['repo-a' as RepoId, 'widgets']]) }
  }
  const before = new Date('2026-01-01T13:00:00.000Z')
  const after = new Date('2026-01-01T15:00:00.000Z')

  it('says when the limit resets and how many sessions wait', () => {
    expect(needsYouLeadCopy(limited(3, RESET), before)).toBe(`Usage limit — resets ${clock} · 3 sessions waiting`)
  })

  it('uses the singular for one session', () => {
    expect(needsYouLeadCopy(limited(1, RESET), before)).toBe(`Usage limit — resets ${clock} · 1 session waiting`)
  })

  it('says so when the reset time is unknown', () => {
    expect(needsYouLeadCopy(limited(3, null), before)).toBe('Usage limit — reset time unknown · 3 sessions waiting')
  })

  it('reads in the past tense once the reset has passed', () => {
    expect(needsYouLeadCopy(limited(3, RESET), after)).toBe(`Usage limit reset at ${clock} · 3 sessions waiting`)
  })

  it('lists each waiting session with its phase and repository', () => {
    const item = limited(2, RESET)
    expect(usageLimitEntryLine(item, item.entries[0] as InterruptedStage)).toBe('#38 Implementing · widgets')
  })

  it('names the reset in the Resume all tooltip', () => {
    expect(resumeAllDisabledReason(RESET)).toBe(`The limit resets at ${clock}. port resumes these sessions then.`)
  })
})

describe('GROUP_NAMES', () => {
  it('names every group the way the screen shows it', () => {
    expect(Object.values(GROUP_NAMES)).toEqual(['Plan reviews', 'Ready to merge', 'Escalated', 'Blocked', 'Questions', 'Denied commands', 'Interrupted', 'Usage limit', 'Held', 'Stalled', 'Over budget', 'Label problems'])
  })
})

describe('dismiss and resume-all toasts', () => {
  it('names the ticket when one item is dismissed, and says "this item" when it has no number', () => {
    expect(dismissedToast([{ number: 554 }])).toBe('Dismissed #554.')
    expect(dismissedToast([{ number: null }])).toBe('Dismissed this item.')
  })

  it('counts a group dismissal', () => {
    expect(dismissedToast([{ number: 1 }, { number: 2 }, { number: null }, { number: 4 }])).toBe('Dismissed 4 items.')
  })

  it('summarizes a resume-all run', () => {
    expect(resumeAllToast(3, 3, null, null)).toBe('Resumed 3 sessions.')
    expect(resumeAllToast(1, 1, null, null)).toBe('Resumed 1 session.')
    expect(resumeAllToast(1, 3, 4, null)).toBe('Resumed 1 of 3. All 4 session slots are busy.')
    expect(resumeAllToast(1, 3, null, { number: 38, reason: 'runtime problem' })).toBe("Couldn't resume #38: runtime problem.")
  })
})

describe('blocker answer copy', () => {
  it('names the agent in the sent toast', () => {
    expect(blockerSentToast(51)).toBe('Sent your answer to #51\'s agent. It clears "Blocked" itself and carries on.')
  })

  it.each([
    ['unknown-session', 'That session has ended. Unblock #51 from its row once the board catches up.'],
    ['unreachable', "Couldn't reach the main process. Nothing was sent."],
    ['blocked-command', "That text is a command the session can't run here. Reword your answer."],
  ] as const)('explains %s', (error, copy) => {
    expect(blockerSendError(error, 51)).toBe(copy)
  })
})

describe('refreshedToast', () => {
  it.each([
    [0, 'Refreshed. Nothing needs you.'],
    [1, 'Refreshed. 1 item needs you.'],
    [3, 'Refreshed. 3 items need you.'],
  ])('counts %i', (count, copy) => {
    expect(refreshedToast(count)).toBe(copy)
  })
})
