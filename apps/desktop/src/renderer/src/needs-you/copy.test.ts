import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { NeedsYouItem } from '../../../shared/board/needs-you'
import { needsYouLeadCopy } from './copy'

function base(overrides: Partial<NeedsYouItem> = {}): Pick<NeedsYouItem, 'repoId' | 'repo' | 'number' | 'title' | 'url' | 'at' | 'matchedRow'> {
  return { repoId: 'repo-a' as RepoId, repo: 'o/a', number: 41, title: 't', url: 'https://github.com/o/a/issues/41', at: null, matchedRow: null, ...overrides }
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
      matchedRow: { decisions: { unblock: { available: true, context: { reason: 'budget exceeded', cyclesUsed: 0, cap: 5 } } } },
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
})
