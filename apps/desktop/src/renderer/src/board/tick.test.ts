// Covers the strip's pure copy functions — `buildTickStrip` itself needs a
// DOM, which this workspace's vitest config does not provide (`environment:
// 'node'`, no jsdom/happy-dom installed), the same gap every other DOM
// builder under `renderer/src/board/` already has.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RepositoryHealth } from '../../../shared/board/types'
import { initialHealth } from '../../../shared/board/types'
import type { TickClaim, TickHeld, TickReport } from '../../../shared/tick/types'
import { clockLineCopy, heldDetailCopy, repositoryLineCopy, stalledDetailCopy } from './tick'

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
        { number: 105, kind: 'issue', trigger: 'ready', agent: 'plan' },
        { number: 112, kind: 'issue', trigger: 'planApproved', agent: 'impl' },
      ],
      held: [{ number: 1, kind: 'issue', trigger: 'ready', reason: 'unowned' }, { number: 2, kind: 'issue', trigger: 'ready', reason: 'unowned' }],
      claims: [
        { number: 3, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null },
        { number: 4, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null },
        { number: 5, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null },
        { number: 6, kind: 'pull-request', inFlight: 'reviewing', class: 'stalled-confirmed', retryKey: 'readyForReview' },
      ],
    })
    expect(repositoryLineCopy(rep)).toBe('o/a — would dispatch plan #105, impl #112 · 2 held · Liveness: 3 claims matched, 1 stalled')
  })
})

describe('heldDetailCopy', () => {
  const base: TickHeld = { number: 118, kind: 'issue', trigger: 'ready', reason: 'unowned' }
  it('covers all three reasons', () => {
    expect(heldDetailCopy(base)).toBe('#118 unassigned — no cockpit will pick this up.')
    expect(heldDetailCopy({ ...base, reason: 'other-operator' })).toBe('#118 assigned to someone else.')
    expect(heldDetailCopy({ ...base, reason: 'session-required' })).toBe('#118 session required — run /port:implement.')
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
