// Covers the board's tick detail copy — pure functions only, since this
// workspace's vitest config has no DOM (`environment: 'node'`, no
// jsdom/happy-dom installed).
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { TickActionable, TickClaim, TickHeld, TickObservation, TickReport } from '@/types/tick'
import { cycleDetailCopy, heldDetailCopy, itemDetailLines, observationDetailCopy, stalledDetailCopy, storeBannerCopy, uncheckedDetailCopy } from '@/renderer/board/tick'

const NOW = new Date('2026-01-01T00:00:00.000Z')

function report(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: 'repo-a' as RepoId, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: NOW.toISOString(), observations: [], autoApprovals: [], labelRepairs: [], ...overrides }
}

describe('storeBannerCopy', () => {
  it('is null once the store has loaded', () => {
    expect(storeBannerCopy({ kind: 'loaded' })).toBeNull()
  })

  it('is null while the store is still being read', () => {
    expect(storeBannerCopy({ kind: 'unread' })).toBeNull()
  })

  it('names the reason and the full path when the file cannot be read', () => {
    expect(storeBannerCopy({ kind: 'unreadable', message: 'boom', path: '/userData/dispatch.json' })).toBe(
      "Every pipeline is paused — dispatch.json can't be read (boom). Fix or delete /userData/dispatch.json, then run each repository again.",
    )
  })
})

describe('heldDetailCopy', () => {
  const base: TickHeld = { number: 118, kind: 'issue', trigger: 'ready', reason: 'unowned', contention: null, escalation: null }
  it('covers all three ownership/session reasons', () => {
    expect(heldDetailCopy(base)).toBe('#118 unassigned — no cockpit will pick this up.')
    expect(heldDetailCopy({ ...base, reason: 'other-operator' })).toBe('#118 assigned to someone else.')
    expect(heldDetailCopy({ ...base, reason: 'session-required' })).toBe('#118 session required — run /port:implement.')
  })

  it('names Needs you, not /port:implement, for a session-required hold while this app owns dispatch', () => {
    const held: TickHeld = { ...base, reason: 'session-required' }
    expect(heldDetailCopy(held, 'app')).toBe('#118 is marked session-required — port runs it and asks you in Needs you before each protected edit.')
    expect(heldDetailCopy(held, 'terminal')).toBe('#118 session required — run /port:implement.')
    expect(heldDetailCopy(held, 'none')).toBe('#118 session required — run /port:implement.')
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

  it('names the re-running check for a pending check-hold', () => {
    const held: TickHeld = {
      number: 594,
      kind: 'pull-request',
      trigger: 'readyForReview',
      reason: 'check-hold',
      contention: null,
      escalation: { kind: 'check-hold', checks: ['run-e2e (macos-latest)'], state: 'pending', escalateAt: null },
    }
    expect(heldDetailCopy(held)).toBe("#594 held — waiting for `run-e2e (macos-latest)` to finish its re-run. It's re-reviewed once it passes.")
  })

  it('names the deadline for a red check-hold, and drops the clause without one', () => {
    const escalateAt = '2026-01-01T16:20:00.000Z'
    const time = new Date(escalateAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const red: TickHeld = {
      number: 594,
      kind: 'pull-request',
      trigger: 'readyForReview',
      reason: 'check-hold',
      contention: null,
      escalation: { kind: 'check-hold', checks: ['a', 'b'], state: 'red', escalateAt },
    }
    expect(heldDetailCopy(red)).toBe(`#594 held — \`a\`, \`b\` are still red on the reviewed head. Re-run them on GitHub; it escalates to needs human at ${time} if they stay red.`)
    const open: TickHeld = { ...red, escalation: { kind: 'check-hold', checks: ['a'], state: 'red', escalateAt: null } }
    expect(heldDetailCopy(open)).toBe('#594 held — `a` is still red on the reviewed head. Re-run it on GitHub.')
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
    expect(observationDetailCopy({ kind: 'liveness-reset', number: 1, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'ready', evidence: 'ledger' })).toBeNull()
    expect(observationDetailCopy({ kind: 'cycle-cap', number: 2, itemKind: 'pull-request', count: 5, cap: 5 })).toBeNull()
    expect(observationDetailCopy({ kind: 'zero-diff', number: 3, itemKind: 'pull-request', count: 1, headRefOid: 'abc' })).toBeNull()
    expect(observationDetailCopy({ kind: 'refresh', number: 4, itemKind: 'pull-request', sourceLabel: 'readyForReview', headRefOid: 'abc', count: 1 })).toBeNull()
    expect(observationDetailCopy({ kind: 'refresh-stuck', number: 5, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'abc', count: 2 })).toBeNull()
    expect(observationDetailCopy({ kind: 'withdraw-approval', number: 6, itemKind: 'pull-request', red: [], headRefOid: 'abc' })).toBeNull()
  })
})
