// Covers the strip's pure copy functions — `buildTickStrip` itself needs a
// DOM, which this workspace's vitest config does not provide (`environment:
// 'node'`, no jsdom/happy-dom installed), the same gap every other DOM
// builder under `renderer/src/board/` already has.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RepositoryHealth } from '../../../shared/board/types'
import { initialHealth } from '../../../shared/board/types'
import type { TickActionable, TickClaim, TickHeld, TickReport } from '../../../shared/tick/types'
import { clockLineCopy, cycleDetailCopy, heldDetailCopy, repositoryLineCopy, stalledDetailCopy, uncheckedDetailCopy } from './tick'

const NOW = new Date('2026-01-01T00:00:00.000Z')

function health(overrides: Partial<RepositoryHealth> = {}): RepositoryHealth {
  return { repoId: 'repo-a' as RepoId, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials'), ...overrides }
}

function report(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: 'repo-a' as RepoId, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: NOW.toISOString(), ...overrides }
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
    expect(repositoryLineCopy(report({ blind: { reason: 'github-unavailable', message: 'boom' } }))).toBe("o/a — can't decide: GitHub is unavailable. Showing the last good read.")
    expect(repositoryLineCopy(report({ blind: { reason: 'viewer-unknown' } }))).toBe("o/a — can't decide: can't tell whose items these are.")
    expect(repositoryLineCopy(report({ blind: { reason: 'stale-read', ageMs: 240_000 } }))).toBe("o/a — can't decide: the label list is 4m old.")
  })

  it('a quiet repository names nothing to dispatch and no in-flight claims', () => {
    expect(repositoryLineCopy(report())).toBe('o/a — nothing to dispatch · Liveness: nothing in flight.')
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
    expect(repositoryLineCopy(rep)).toBe('o/a — would dispatch plan #105, impl #112 · 2 held · Liveness: 3 claims matched, 1 stalled')
  })

  it('names an unstructured plan as a count, never omitted (#106)', () => {
    const rep = report({ actionable: [{ number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: true, cycle: null }] })
    expect(repositoryLineCopy(rep)).toBe('o/a — would dispatch impl #52 · 1 plan unchecked · Liveness: nothing in flight.')
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
})
