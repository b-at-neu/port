// Covers the strip's pure copy functions — `buildTickStrip` itself needs a
// DOM, which this workspace's vitest config does not provide (`environment:
// 'node'`, no jsdom/happy-dom installed), the same gap every other DOM
// builder under `renderer/src/board/` already has.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RepositoryHealth } from '../../../shared/board/types'
import { initialHealth } from '../../../shared/board/types'
import type { TickActionable, TickClaim, TickHeld, TickObservation, TickReport } from '../../../shared/tick/types'
import type { RunState } from '../../../shared/dispatch/types'
import { clockLineCopy, cycleDetailCopy, heldDetailCopy, itemDetailLines, observationDetailCopy, repositoryDetailLines, repositoryLineCopy, stalledDetailCopy, storeLineFor, uncheckedDetailCopy } from './tick'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const DISPATCHING: RunState = 'dispatching'

function health(overrides: Partial<RepositoryHealth> = {}): RepositoryHealth {
  return { repoId: 'repo-a' as RepoId, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials'), ...overrides }
}

function report(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: 'repo-a' as RepoId, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: NOW.toISOString(), observations: [], autoApprovals: [], ...overrides }
}

describe('clockLineCopy', () => {
  it('renders "no wakeup scheduled" when null', () => {
    expect(clockLineCopy(null, [], NOW)).toBe('No wakeup scheduled.')
  })

  it('renders "now" once the due instant has passed', () => {
    expect(clockLineCopy(new Date(NOW.getTime() - 1).toISOString(), [], NOW)).toBe('Next wakeup — now')
  })

  it('renders a minute:second countdown', () => {
    expect(clockLineCopy(new Date(NOW.getTime() + 42_000).toISOString(), [], NOW)).toBe('Next wakeup in 0:42')
    expect(clockLineCopy(new Date(NOW.getTime() + 90_000).toISOString(), [], NOW)).toBe('Next wakeup in 1:30')
  })

  it('renders the rate-limit wait when the due instant is a deferral', () => {
    const dueAt = new Date(NOW.getTime() + 3_600_000)
    const h = health({ github: { ...initialHealth('github'), deferredUntil: dueAt.toISOString() } })
    expect(clockLineCopy(dueAt.toISOString(), [h], NOW)).toContain('waiting out the GitHub rate-limit window')
  })
})

describe('repositoryLineCopy', () => {
  it('a blind repository never shows dispatch or held counts', () => {
    expect(repositoryLineCopy(report({ blind: { reason: 'github-unavailable', message: 'boom' } }), DISPATCHING)).toBe("o/a — can't decide: GitHub is unavailable. Showing the last good read.")
    expect(repositoryLineCopy(report({ blind: { reason: 'viewer-unknown' } }), DISPATCHING)).toBe("o/a — can't decide: can't tell whose items these are.")
    expect(repositoryLineCopy(report({ blind: { reason: 'stale-read', ageMs: 240_000 } }), DISPATCHING)).toBe("o/a — can't decide: the label list is 4m old.")
  })

  it('a quiet repository names nothing to dispatch and no in-flight claims', () => {
    expect(repositoryLineCopy(report(), DISPATCHING)).toBe('o/a — nothing to dispatch · Liveness: nothing in flight.')
  })

  it('a repository with work to do names every actionable item, the held count, and the liveness split', () => {
    const rep = report({
      actionable: [
        { number: 105, kind: 'issue', trigger: 'ready', agent: 'plan', unchecked: false, cycle: null },
        { number: 112, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null },
      ],
      held: [
        { number: 1, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null },
        { number: 2, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null },
      ],
      claims: [
        { number: 3, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null },
        { number: 4, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null },
        { number: 5, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null },
        { number: 6, kind: 'pull-request', inFlight: 'reviewing', class: 'stalled-confirmed', retryKey: 'readyForReview' },
      ],
    })
    expect(repositoryLineCopy(rep, DISPATCHING)).toBe('o/a — would dispatch plan #105, impl #112 · 2 held · Liveness: 3 claims matched, 1 stalled')
  })

  it('names an unstructured plan as a count, never omitted (#106)', () => {
    const rep = report({ actionable: [{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: true, cycle: null }] })
    expect(repositoryLineCopy(rep, DISPATCHING)).toBe('o/a — would dispatch impl #52 · 1 plan unchecked · Liveness: nothing in flight.')
  })

  it('never renders "nothing to dispatch" while draining — a held set and an empty one are different facts (#110)', () => {
    expect(repositoryLineCopy(report(), 'draining')).toBe('o/a — draining: nothing would dispatch · Liveness: nothing in flight.')
  })

  it('never renders "nothing to dispatch" while paused either (#314)', () => {
    expect(repositoryLineCopy(report(), 'paused')).toBe('o/a — paused: nothing would dispatch · Liveness: nothing in flight.')
  })

  it('names every held-back candidate while draining, instead of "would dispatch"', () => {
    const rep = report({
      actionable: [
        { number: 105, kind: 'issue', trigger: 'ready', agent: 'plan', unchecked: false, cycle: null },
        { number: 112, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null },
      ],
    })
    expect(repositoryLineCopy(rep, 'draining')).toBe('o/a — draining: 2 would dispatch, held back (plan #105, impl #112) · Liveness: nothing in flight.')
  })

  it('names every held-back candidate while paused too', () => {
    const rep = report({ actionable: [{ number: 105, kind: 'issue', trigger: 'ready', agent: 'plan', unchecked: false, cycle: null }] })
    expect(repositoryLineCopy(rep, 'paused')).toBe('o/a — paused: 1 would dispatch, held back (plan #105) · Liveness: nothing in flight.')
  })

  it('#265: "would dispatch" becomes "dispatched" when this app owns dispatch for the repository', () => {
    const rep = report({ actionable: [{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }] })
    expect(repositoryLineCopy(rep, DISPATCHING, 'app')).toBe('o/a — dispatched impl #52 · Liveness: nothing in flight.')
    expect(repositoryLineCopy(rep, DISPATCHING, 'none')).toBe('o/a — would dispatch impl #52 · Liveness: nothing in flight.')
    expect(repositoryLineCopy(rep, DISPATCHING)).toBe('o/a — would dispatch impl #52 · Liveness: nothing in flight.')
  })

  it('#265: draining still says "would dispatch", even when this app owns dispatch', () => {
    const rep = report({ actionable: [{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }] })
    expect(repositoryLineCopy(rep, 'draining', 'app')).toBe('o/a — draining: 1 would dispatch, held back (impl #52) · Liveness: nothing in flight.')
  })
})

describe('storeLineFor', () => {
  it('is null once the store has loaded', () => {
    expect(storeLineFor({ kind: 'loaded' })).toBeNull()
  })

  it('reads as reading the saved state before load() resolves', () => {
    expect(storeLineFor({ kind: 'unread' })).toEqual({ text: 'Reading the saved pipeline state…', title: null })
  })

  it('carries the full path as the title when the file cannot be read', () => {
    const line = storeLineFor({ kind: 'unreadable', message: 'boom', path: '/userData/dispatch.json' })
    expect(line?.text).toContain("can't be read (boom)")
    expect(line?.title).toBe('/userData/dispatch.json')
  })
})

describe('heldDetailCopy', () => {
  const base: TickHeld = { number: 118, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null }
  it('covers all three ownership/session reasons', () => {
    expect(heldDetailCopy(base)).toBe('#118 unassigned — no cockpit will pick this up.')
    expect(heldDetailCopy({ ...base, reason: 'other-operator' })).toBe('#118 assigned to someone else.')
    expect(heldDetailCopy({ ...base, reason: 'session-required' })).toBe('#118 session required — run /port:implement.')
  })

  it('names the blocker and contended files for a contended hold (#106)', () => {
    const held: TickHeld = {
      number: 118,
      kind: 'issue',
      trigger: 'planApproved',
      reason: 'contended',
      contention: { blocker: 67, blockerStage: 'in progress', depth: 2, paths: ['src/lib/auth.ts', 'src/lib/session.ts'] },
      escalation: null,
    }
    expect(heldDetailCopy(held)).toBe('#118 held behind #67 — 2 contended files: src/lib/auth.ts, src/lib/session.ts.')
  })

  it('truncates a contended hold past three paths with an "and N more" clause (#106)', () => {
    const held: TickHeld = {
      number: 118,
      kind: 'issue',
      trigger: 'planApproved',
      reason: 'contended',
      contention: { blocker: 67, blockerStage: 'in progress', depth: 5, paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'] },
      escalation: null,
    }
    expect(heldDetailCopy(held)).toBe('#118 held behind #67 — 5 contended files: src/a.ts, src/b.ts, src/c.ts and 2 more.')
  })

  it('names the cycle count and cap for a cycle-cap hold (#108)', () => {
    const held: TickHeld = {
      number: 204,
      kind: 'pull-request',
      trigger: 'needsRevision',
      reason: 'cycle-cap',
      contention: null,
      escalation: { kind: 'cycle-cap', count: 5, cap: 5 },
    }
    expect(heldDetailCopy(held)).toBe('#204 would escalate to needs human — cycle 5 reached the cap of 5.')
  })

  it('names the zero-diff fact for a zero-diff hold (#108)', () => {
    const held: TickHeld = { number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'zero-diff', contention: null, escalation: { kind: 'zero-diff' } }
    expect(heldDetailCopy(held)).toBe('#157 would escalate to needs human — the latest review already covers the current head.')
  })

  it('#292: owner "app" reads cycle-cap and zero-diff in the present tense, since this app is the one escalating', () => {
    const capped: TickHeld = { number: 204, kind: 'pull-request', trigger: 'needsRevision', reason: 'cycle-cap', contention: null, escalation: { kind: 'cycle-cap', count: 5, cap: 5 } }
    expect(heldDetailCopy(capped, 'app')).toBe('#204 escalating to needs human — cycle 5 reached the cap of 5.')
    expect(heldDetailCopy(capped, 'none')).toBe('#204 would escalate to needs human — cycle 5 reached the cap of 5.')

    const zeroDiff: TickHeld = { number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'zero-diff', contention: null, escalation: { kind: 'zero-diff' } }
    expect(heldDetailCopy(zeroDiff, 'app')).toBe('#157 escalating to needs human — the latest review already covers the current head.')
    expect(heldDetailCopy(zeroDiff, 'none')).toBe('#157 would escalate to needs human — the latest review already covers the current head.')
  })

  it('#292: a conflicting hold reads as this app actively refreshing it, instead of naming the cockpit\'s sweep', () => {
    const held: TickHeld = { number: 88, kind: 'pull-request', trigger: 'readyForReview', reason: 'conflicting', contention: null, escalation: null }
    expect(heldDetailCopy(held, 'app')).toBe('#88 conflicts — this app is refreshing it (rebase + force-push).')
    expect(heldDetailCopy(held, 'none')).toBe("#88 held — GitHub reports merge conflicts. The cockpit's refresh sweep rebases it; this app doesn't.")
    expect(heldDetailCopy(held)).toBe("#88 held — GitHub reports merge conflicts. The cockpit's refresh sweep rebases it; this app doesn't.")
  })
})

describe('uncheckedDetailCopy', () => {
  it('names the item and the reason it dispatches unchecked (#106)', () => {
    const actionable: TickActionable = { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: true, cycle: null }
    expect(uncheckedDetailCopy(actionable)).toBe('#52 has no file list in its plan — dispatching unchecked.')
  })
})

describe('cycleDetailCopy', () => {
  it('names the cycle count and cap for a candidate that carries one (#108)', () => {
    const actionable: TickActionable = { number: 204, kind: 'pull-request', trigger: 'needsRevision', agent: 'revise', unchecked: false, cycle: { count: 4, cap: 5 } }
    expect(cycleDetailCopy(actionable)).toBe('#204 revise — cycle 4 of 5.')
  })

  it('is null for a candidate with no cycle count', () => {
    const actionable: TickActionable = { number: 105, kind: 'issue', trigger: 'ready', agent: 'plan', unchecked: false, cycle: null }
    expect(cycleDetailCopy(actionable)).toBeNull()
  })
})

describe('stalledDetailCopy', () => {
  const base: TickClaim = { number: 146, kind: 'pull-request', inFlight: 'reviewing', class: 'no-record', retryKey: null }
  it('a confirmed stall names the retry target', () => {
    expect(stalledDetailCopy({ ...base, class: 'stalled-confirmed', retryKey: 'readyForReview' })).toBe(
      '#146 reviewing — no claim, and this app dispatched it. Retry re-applies "ready for review".',
    )
  })

  it('a no-record stall never offers a retry', () => {
    expect(stalledDetailCopy(base)).toBe("#146 reviewing — no claim, and this app didn't dispatch it, so it can't tell.")
  })

  it('matched and session-required claims have no stalled detail at all', () => {
    expect(stalledDetailCopy({ ...base, class: 'matched' })).toBeNull()
    expect(stalledDetailCopy({ ...base, class: 'session-required' })).toBeNull()
  })

  it('#292: owner "app" reads a confirmed stall as this app resetting it, rather than asking the operator to retry', () => {
    const confirmed: TickClaim = { ...base, class: 'stalled-confirmed', retryKey: 'readyForReview' }
    expect(stalledDetailCopy(confirmed, 'app')).toBe('#146 reviewing — no agent, and this app dispatched it. Resetting to ready for review.')
    expect(stalledDetailCopy(confirmed, 'none')).toBe('#146 reviewing — no claim, and this app dispatched it. Retry re-applies "ready for review".')
  })

  it('#292: owner "app" makes no difference when there is no retry key to apply', () => {
    const confirmed: TickClaim = { ...base, class: 'stalled-confirmed', retryKey: null }
    expect(stalledDetailCopy(confirmed, 'app')).toBe('#146 reviewing — no claim, and this app dispatched it.')
  })
})

describe('repositoryDetailLines', () => {
  it('concatenates held, unchecked, cycle, stalled and observation lines', () => {
    const rep = report({
      held: [{ number: 1, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null }],
      actionable: [{ number: 2, kind: 'pull-request', trigger: 'needsRevision', agent: 'revise', unchecked: true, cycle: { count: 1, cap: 5 } }],
      claims: [{ number: 3, kind: 'issue', inFlight: 'inProgress', class: 'no-record', retryKey: null }],
      observations: [{ kind: 'refresh-deferred', number: 4, itemKind: 'pull-request' }],
    })
    const lines = repositoryDetailLines(rep, 'none')
    expect(lines).toEqual([
      '#1 unassigned — no cockpit will pick this up.',
      '#2 has no file list in its plan — dispatching unchecked.',
      '#2 revise — cycle 1 of 5.',
      "#3 in progress — no claim, and this app didn't dispatch it, so it can't tell.",
      '#4 conflicts too — refreshes are capped this poll; it goes next.',
    ])
  })

  it('is empty for a blind repository', () => {
    expect(repositoryDetailLines(report({ blind: { reason: 'viewer-unknown' } }), 'none')).toEqual([])
  })
})

describe('itemDetailLines', () => {
  it('narrows every source to one item number', () => {
    const rep = report({
      held: [
        { number: 1, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null },
        { number: 2, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null },
      ],
      claims: [{ number: 1, kind: 'issue', inFlight: 'inProgress', class: 'no-record', retryKey: null }],
    })
    expect(itemDetailLines(rep, 1, 'none')).toEqual(['#1 unassigned — no cockpit will pick this up.', "#1 in progress — no claim, and this app didn't dispatch it, so it can't tell."])
    expect(itemDetailLines(rep, 2, 'none')).toEqual(['#2 unassigned — no cockpit will pick this up.'])
  })

  it('is empty for a blind repository', () => {
    expect(itemDetailLines(report({ blind: { reason: 'viewer-unknown' } }), 1, 'none')).toEqual([])
  })
})

describe('observationDetailCopy', () => {
  it('names a deferred refresh as conflicting too, capped for this pass', () => {
    const observation: TickObservation = { kind: 'refresh-deferred', number: 73, itemKind: 'pull-request' }
    expect(observationDetailCopy(observation)).toBe('#73 conflicts too — refreshes are capped this poll; it goes next.')
  })

  it('every write-bearing kind has no detail line of its own here — it already has one from held/stalled above', () => {
    expect(observationDetailCopy({ kind: 'liveness-reset', number: 1, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'ready' })).toBeNull()
    expect(observationDetailCopy({ kind: 'cycle-cap', number: 2, itemKind: 'pull-request', count: 5, cap: 5 })).toBeNull()
    expect(observationDetailCopy({ kind: 'zero-diff', number: 3, itemKind: 'pull-request', count: 1, headRefOid: 'abc' })).toBeNull()
    expect(observationDetailCopy({ kind: 'refresh', number: 4, itemKind: 'pull-request', sourceLabel: 'readyForReview', headRefOid: 'abc', count: 1 })).toBeNull()
    expect(observationDetailCopy({ kind: 'refresh-stuck', number: 5, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'abc', count: 2 })).toBeNull()
    expect(observationDetailCopy({ kind: 'withdraw-approval', number: 6, itemKind: 'pull-request', red: [], headRefOid: 'abc' })).toBeNull()
  })
})
