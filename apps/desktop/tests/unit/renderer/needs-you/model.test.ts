import { describe, expect, it } from 'vitest'
import type { NeedsYouItem } from '@/types/board'
import {
  actionFor,
  allowToastOf,
  approvalToastOf,
  emptyStateOf,
  forceDispatchToastOf,
  hasDetail,
  intentOf,
  labelActionToastOf,
  restartToastOf,
  resumeAllStep,
  resumeToastOf,
  secondaryIntentOf,
  staleForMs,
} from '@/renderer/needs-you/model'

const RESET = '2026-01-01T14:05:00.000Z'
const BEFORE = new Date('2026-01-01T13:00:00.000Z')
const AFTER = new Date('2026-01-01T15:00:00.000Z')

function make(kind: string, fields: object = {}): NeedsYouItem {
  return { kind, repoId: 'repo-a', repo: 'o/a', number: 7, title: 't', url: 'https://github.com/o/a/issues/7', ticket: null, at: null, matchedRow: null, ...fields } as unknown as NeedsYouItem
}

const interrupted = (reason: string, claudeSessionId: string | null = 'c1') => make('stage-interrupted', { interrupted: { id: 'e1', agent: 'revise', number: 7, reason, claudeSessionId, worktree: { path: '/wt/7' } } })
const usageLimit = (resetsAt: string | null) => make('usage-limit', { entries: [{ id: 'a', number: 1 }], resetsAt })
const held = (reason: string, fields: object = {}) => make('held', { held: { reason, contention: null }, owner: 'app', ...fields })
const approval = make('stage-approval', { sessionKey: 'hosted-1', permissionId: 'p1', path: '.claude/x', agent: 'impl', toolName: 'Edit' })
const row = (decisions: object) => ({ decisions, stageLabel: { key: 'approved' }, item: { kind: 'pull-request' } })
const available = (context: object = {}) => ({ available: true, context })

describe('actionFor', () => {
  it.each([
    ['plan-review', make('plan-review'), 'review-plan', true, false],
    ['budget', make('budget'), 'open', true, false],
    ['stalled', make('stalled'), 'retry', true, false],
    ['stage-question', make('stage-question'), 'answer', true, false],
    ['stage-questions', make('stage-questions'), 'open', true, false],
    ['stage-approval', approval, 'approve', true, true],
    ['stage-denial', make('stage-denial'), 'allow', true, false],
    ['crash', interrupted('crash'), 'resume', true, true],
    ['crash with no claude session', interrupted('crash', null), 'resume', false, true],
    ['cleanup-failed', interrupted('cleanup-failed'), 'copy-path', true, false],
    ['half-labelled', make('half-labelled'), 'open', true, false],
    ['dispatch-failed', make('dispatch-failed'), 'open', true, false],
    ['held conflicting', held('conflicting'), 'refresh', true, false],
    ['held contended on app', held('contended'), 'force', true, false],
    ['held contended elsewhere', held('contended', { owner: 'cockpit' }), 'force', false, false],
    ['held other', held('other'), 'open', true, false],
  ])('%s', (_name, item, kind, enabled, secondary) => {
    const action = actionFor(item, BEFORE)
    expect([action.kind, action.disabledReason === null, action.secondaryLabel !== undefined]).toEqual([kind, enabled, secondary])
  })

  it.each([
    ['before the reset', RESET, BEFORE, false],
    ['after the reset', RESET, AFTER, true],
    ['with no known reset', null, BEFORE, true],
  ])('usage limit %s', (_name, resetsAt, now, enabled) => {
    expect(actionFor(usageLimit(resetsAt), now).disabledReason === null).toBe(enabled)
  })

  it.each([
    ['available', row({ unblock: available() }), true],
    ['refused', row({ unblock: { available: false, reason: 'agent-live' } }), false],
    ['no matched row', null, false],
  ])('blocked and needs-human with unblock %s', (_name, matchedRow, enabled) => {
    expect(actionFor(make('blocked', { matchedRow }), BEFORE).disabledReason === null).toBe(enabled)
    expect(actionFor(make('needs-human', { matchedRow }), BEFORE).disabledReason === null).toBe(enabled)
  })

  it.each([
    ['available', row({ grant: available() }), true],
    ['refused', row({ grant: { available: false, reason: 'not-owned' } }), false],
    ['no matched row', null, false],
  ])('cycle-capped held row with grant %s', (_name, matchedRow, enabled) => {
    const action = actionFor(held('cycle-cap', { matchedRow }), BEFORE)
    expect([action.kind, action.disabledReason === null, action.secondaryLabel]).toEqual(['grant', enabled, 'Open PR'])
  })

  it.each([
    ['available', { available: true, context: {} }, true, true],
    ['at the cycle cap', { available: false, reason: 'cycle-cap' }, true, false],
    ['not owned', { available: false, reason: 'not-owned' }, true, false],
    ['not applicable', { available: false, reason: 'not-applicable' }, false, true],
  ])('ready to merge with revise %s', (_name, revise, hasSecondary, secondaryEnabled) => {
    const action = actionFor(make('ready-to-merge', { row: row({ revise }) }), BEFORE)
    expect([action.secondaryLabel !== undefined, (action.secondaryDisabledReason ?? null) === null]).toEqual([hasSecondary, secondaryEnabled])
  })
})

describe('intentOf', () => {
  it.each([
    ['plan-review', make('plan-review'), { kind: 'review-plan', repoId: 'repo-a', number: 7 }],
    ['open ticket', make('budget'), { kind: 'url', url: 'https://github.com/o/a/issues/7' }],
    ['open with no url', make('budget', { url: null }), null],
    ['questions hand-back', make('stage-questions', { sessionKey: 'hosted-9' }), { kind: 'session', sessionKey: 'hosted-9' }],
    ['answer', make('stage-question'), { kind: 'expand' }],
    ['allow', make('stage-denial', { denial: { id: 'd1' } }), { kind: 'allow', repoId: 'repo-a', denial: { id: 'd1' } }],
    ['allow without a repo', make('stage-denial', { repoId: null, denial: { id: 'd1' } }), null],
    ['approve', approval, { kind: 'approve', decision: 'allow-once', sessionKey: 'hosted-1', permissionId: 'p1', path: '.claude/x' }],
    ['resume', interrupted('crash'), { kind: 'resume', id: 'e1', number: 7 }],
    ['resume disabled', interrupted('crash', null), null],
    ['copy path', interrupted('cleanup-failed'), { kind: 'copy-path', path: '/wt/7', label: '#7' }],
    ['resume all after the reset', usageLimit(null), { kind: 'resume-all', entries: [{ id: 'a', number: 1 }] }],
    ['resume all before the reset', usageLimit('2999-01-01T00:00:00.000Z'), null],
    ['force', held('contended'), { kind: 'force', repoId: 'repo-a', number: 7 }],
    ['force elsewhere', held('contended', { owner: 'cockpit' }), null],
    ['unblock', make('blocked', { matchedRow: row({ unblock: available({ reason: 'r' }) }) }), { kind: 'decision', request: { repoId: 'repo-a', number: 7, decision: 'unblock', expectedStage: 'approved', context: { reason: 'r' } } }],
    ['unblock refused', make('blocked', { matchedRow: row({ unblock: { available: false, reason: 'agent-live' } }) }), null],
    ['retry', make('stalled', { matchedRow: row({}) }), { kind: 'label', action: 'retry', input: { repoId: 'repo-a', kind: 'pull-request', number: 7, action: 'retry', expectedStage: 'approved' }, shown: '7' }],
    ['refresh without a matched row', held('conflicting'), { kind: 'label', action: 'refresh', input: { repoId: 'repo-a', kind: 'pull-request', number: 7, action: 'refresh', expectedStage: null }, shown: '7' }],
  ])('%s', (_name, item, expected) => {
    expect(intentOf(item)).toEqual(expected)
  })
})

describe('secondaryIntentOf', () => {
  it.each([
    ['restart', interrupted('crash'), { kind: 'restart', id: 'e1' }],
    ['deny', approval, { kind: 'approve', decision: 'deny', sessionKey: 'hosted-1', permissionId: 'p1', path: '.claude/x' }],
    ['open the PR on a cycle-capped row', held('cycle-cap', { matchedRow: row({ grant: available() }) }), { kind: 'url', url: 'https://github.com/o/a/issues/7' }],
    ['revise', make('ready-to-merge', { row: row({ revise: available({ cap: 5 }) }) }), { kind: 'decision', request: { repoId: 'repo-a', number: 7, decision: 'revise', expectedStage: 'approved', context: { cap: 5 } } }],
    ['revise at the cap', make('ready-to-merge', { row: row({ revise: { available: false, reason: 'cycle-cap' } }) }), null],
    ['a row with no secondary', make('stalled'), null],
  ])('%s', (_name, item, expected) => {
    expect(secondaryIntentOf(item)).toEqual(expected)
  })
})

describe('hasDetail', () => {
  it.each([
    ['contended with contention', held('contended', { held: { reason: 'contended', contention: { paths: [] } } }), true],
    ['contended without it', held('contended'), false],
    ['usage-limit', usageLimit(null), true],
    ['stage-question', make('stage-question'), true],
    ['stage-denial', make('stage-denial'), true],
    ['stage-approval', approval, true],
    ['dispatch-failed', make('dispatch-failed'), true],
    ['cleanup-failed', interrupted('cleanup-failed'), true],
    ['crash', interrupted('crash'), false],
    ['stalled', make('stalled'), false],
  ])('%s', (_name, item, expected) => {
    expect(hasDetail(item)).toBe(expected)
  })
})

describe('emptyStateOf', () => {
  it.each([
    [{ scoped: false, dismissedCount: 2, dismissedShown: false }, 'show-dismissed'],
    [{ scoped: true, dismissedCount: 2, dismissedShown: false }, 'show-dismissed'],
    [{ scoped: true, dismissedCount: 2, dismissedShown: true }, 'scoped'],
    [{ scoped: true, dismissedCount: 0, dismissedShown: false }, 'scoped'],
    [{ scoped: false, dismissedCount: 0, dismissedShown: false }, 'all'],
  ] as const)('%j is %s', (state, expected) => {
    expect(emptyStateOf(state)).toBe(expected)
  })
})

describe('staleForMs', () => {
  const now = new Date(10 * 60_000)
  it.each([
    ['4m59s old', now.getTime() - (4 * 60_000 + 59_000), null],
    ['5m01s old', now.getTime() - (5 * 60_000 + 1_000), 5 * 60_000 + 1_000],
    ['no data yet', 0, null],
  ])('%s', (_name, updatedAt, expected) => {
    expect(staleForMs(updatedAt, now)).toBe(expected)
  })
})

describe('resumeAllStep', () => {
  const tally = { resumed: 1, attempted: 1, total: 3 }
  it.each([
    ['ok', { kind: 'ok', sessionKey: 's' }, 'continue', { resumed: 2, attempted: 2, total: 3 }],
    ['unknown-stage', { kind: 'unknown-stage' }, 'continue', tally],
    ['at-capacity', { kind: 'at-capacity', limit: 4 }, 'stop', null],
    ['start-failed', { kind: 'start-failed', message: 'boom' }, 'stop', null],
    ['no-session-id', { kind: 'no-session-id' }, 'stop', null],
  ] as const)('%s', (_name, result, kind, next) => {
    const step = resumeAllStep(tally, result, 9)
    expect(step.kind).toBe(kind)
    if (step.kind === 'continue') expect(step.tally).toEqual(next)
  })
})

describe('result toasts', () => {
  it.each([
    ['ok', { kind: 'ok' }, 'success'],
    ['worktree-dirty', { kind: 'worktree-dirty' }, 'error'],
    ['worktree-remove-failed', { kind: 'worktree-remove-failed', message: 'm' }, 'error'],
    ['label-refused', { kind: 'label-refused', reason: 'r' }, 'error'],
    ['unknown-stage', { kind: 'unknown-stage' }, 'info'],
  ] as const)('restart %s', (_name, result, tone) => {
    expect(restartToastOf(7, result).tone).toBe(tone)
  })

  it.each([
    ['ok', { kind: 'ok' }, 'success'],
    ['not-held', { kind: 'not-held' }, 'info'],
    ['not-owned', { kind: 'not-owned' }, 'error'],
  ] as const)('force dispatch %s', (_name, result, tone) => {
    expect(forceDispatchToastOf(7, result).tone).toBe(tone)
  })

  it.each([
    ['proposed', { kind: 'proposed', number: 1, url: 'u' }, 'success', true],
    ['already-proposed', { kind: 'already-proposed', number: 1, url: 'u' }, 'info', true],
    ['already-allowed', { kind: 'already-allowed', integration: 'dev' }, 'info', false],
    ['invalid-rule', { kind: 'invalid-rule', reason: 'r' }, 'error', false],
    ['failed', { kind: 'failed', step: 'pr', message: 'm' }, 'error', false],
    ['unknown-denial', { kind: 'unknown-denial' }, 'info', false],
  ] as const)('allow %s', (_name, result, tone, offersPr) => {
    const opened: string[] = []
    const shown = allowToastOf('Bash(x)', result, (url) => opened.push(url))
    expect(shown.tone).toBe(tone)
    shown.action?.onClick()
    expect(opened).toEqual(offersPr ? ['u'] : [])
  })

  it.each([
    ['ok', { kind: 'ok', sessionKey: 's' }, 'success'],
    ['at-capacity', { kind: 'at-capacity', limit: 4 }, 'error'],
    ['no-session-id', { kind: 'no-session-id' }, 'error'],
    ['start-failed', { kind: 'start-failed', message: 'm' }, 'error'],
    ['unknown-stage', { kind: 'unknown-stage' }, 'info'],
  ] as const)('resume %s', (_name, result, tone) => {
    expect(resumeToastOf(7, result).tone).toBe(tone)
  })

  it.each([
    ['done', { ok: true, outcome: {} }, 'success'],
    ['refused', { ok: false, reason: 'moved', expected: 'a', observed: 'b' }, 'error'],
  ] as const)('label action %s', (_name, result, tone) => {
    expect(labelActionToastOf('retry', '7', result as never).tone).toBe(tone)
  })

  it.each([
    ['answered', { ok: true }, 'success'],
    ['no longer waiting', { ok: false }, 'info'],
  ] as const)('approval %s', (_name, result, tone) => {
    expect(approvalToastOf('allow-once', 'p', result).tone).toBe(tone)
  })
})
