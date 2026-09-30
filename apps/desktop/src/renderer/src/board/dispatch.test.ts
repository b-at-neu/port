// Covers the header controls' pure copy functions — `buildHaltReport` itself
// needs a DOM, which this workspace's vitest config does not provide
// (`environment: 'node'`), the same gap `tick.test.ts` already documents.
// `handleDrainToggle`/`handleHaltClick` reach `window.port`, so — like
// `board/actions.ts`'s own `handleItemAction` — they are left untested here
// too; only the derived copy is asserted.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { DispatchControlResult, HaltItemOutcome, HaltReport } from '../../../shared/dispatch/types'
import { drainResultNote, drainToggleLabel, haltButtonLabel, haltAbortedCopy, haltHeadingCopy, haltItemLine } from './dispatch'

describe('drainToggleLabel', () => {
  it('reads Drain while the gate is open', () => {
    expect(drainToggleLabel({ gate: 'open' })).toBe('Drain')
  })

  it('reads Resume dispatch while draining, whatever the reason', () => {
    expect(drainToggleLabel({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' })).toBe('Resume dispatch')
    expect(drainToggleLabel({ gate: 'draining', reason: 'unread' })).toBe('Resume dispatch')
    expect(drainToggleLabel({ gate: 'draining', reason: 'unreadable', message: 'boom', path: '/dispatch.json' })).toBe('Resume dispatch')
  })
})

describe('drainResultNote', () => {
  it('says nothing for an ordinary persisted drain', () => {
    const result: Extract<DispatchControlResult, { readonly command: 'drain' }> = { ok: true, command: 'drain', drain: { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }, persisted: true }
    expect(drainResultNote(result)).toBeNull()
  })

  it('warns once a drain write fails to persist, since the gate still closed in memory', () => {
    const result: Extract<DispatchControlResult, { readonly command: 'drain' }> = { ok: true, command: 'drain', drain: { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }, persisted: false }
    expect(drainResultNote(result)).toBe("Drain applied, but wasn't saved to disk — it won't survive a restart.")
  })

  it('says nothing for an ordinary successful resume', () => {
    const result: Extract<DispatchControlResult, { readonly command: 'resume' }> = { ok: true, command: 'resume', drain: { gate: 'open' } }
    expect(drainResultNote(result)).toBeNull()
  })

  it('names the path and message for a refused resume', () => {
    const result: Extract<DispatchControlResult, { readonly command: 'resume' }> = { ok: false, command: 'resume', reason: 'drain-unwritable', message: 'disk full', path: '/userData/dispatch.json' }
    expect(drainResultNote(result)).toBe("Resume refused — /userData/dispatch.json couldn't be written (disk full). Dispatch is still draining.")
  })
})

describe('haltButtonLabel', () => {
  it('reads Halt everything before any confirm step is armed', () => {
    expect(haltButtonLabel(4)).toBe('Halt everything')
  })
})

describe('haltItemLine', () => {
  const NOW = new Date('2026-01-01T00:00:00Z')

  it('names the removed label for a stopped item with nothing attached', () => {
    const outcome: HaltItemOutcome = { kind: 'stopped', number: 148, itemKind: 'issue', repoId: 'repo-a' as RepoId, removedLabel: 'reviewing', attachedAgent: null }
    expect(haltItemLine(outcome, NOW)).toBe('#148 reviewing → no stage.')
  })

  it('names an attached agent without failing the line', () => {
    const outcome: HaltItemOutcome = { kind: 'stopped', number: 148, itemKind: 'issue', repoId: 'repo-a' as RepoId, removedLabel: 'reviewing', attachedAgent: 'review-agent' }
    expect(haltItemLine(outcome, NOW)).toBe("#148 reviewing → no stage. review-agent still attached — this app can't stop it.")
  })

  it('names session-required, not-owned, and viewer-unknown skips', () => {
    const sessionRequired: HaltItemOutcome = { kind: 'skipped', number: 151, itemKind: 'issue', repoId: 'repo-a' as RepoId, reason: 'session-required', owner: null }
    expect(haltItemLine(sessionRequired, NOW)).toBe('#151 skipped — session required; your own /port:implement session owns it.')

    const notOwned: HaltItemOutcome = { kind: 'skipped', number: 152, itemKind: 'issue', repoId: 'repo-a' as RepoId, reason: 'not-owned', owner: 'alice' }
    expect(haltItemLine(notOwned, NOW)).toBe('#152 skipped — @alice owns it.')
  })

  it('reuses the ordinary row action copy for a refused outcome', () => {
    const outcome: HaltItemOutcome = {
      kind: 'refused',
      number: 153,
      itemKind: 'issue',
      repoId: 'repo-a' as RepoId,
      result: { ok: true, outcome: { kind: 'no-op' } },
    }
    expect(haltItemLine(outcome, NOW)).toBe('#153 not stopped — #153 already reads that way. Nothing was written.')
  })
})

describe('haltHeadingCopy', () => {
  it('names stopped and skipped counts, with no not-stopped clause when nothing was refused', () => {
    const report: Extract<HaltReport, { readonly kind: 'completed' }> = {
      kind: 'completed',
      items: [
        { kind: 'stopped', number: 1, itemKind: 'issue', repoId: 'repo-a' as RepoId, removedLabel: 'reviewing', attachedAgent: null },
        { kind: 'stopped', number: 2, itemKind: 'issue', repoId: 'repo-a' as RepoId, removedLabel: 'in progress', attachedAgent: null },
        { kind: 'skipped', number: 3, itemKind: 'issue', repoId: 'repo-a' as RepoId, reason: 'not-owned', owner: 'alice' },
      ],
    }
    expect(haltHeadingCopy(report)).toBe('Halted · 2 stopped, 1 skipped')
  })

  it('adds a not-stopped clause once a refusal actually happened', () => {
    const report: Extract<HaltReport, { readonly kind: 'completed' }> = {
      kind: 'completed',
      items: [{ kind: 'refused', number: 1, itemKind: 'issue', repoId: 'repo-a' as RepoId, result: { ok: false, reason: 'viewer-unknown' } }],
    }
    expect(haltHeadingCopy(report)).toBe('Halted · 0 stopped, 0 skipped, 1 not stopped')
  })
})

describe('haltAbortedCopy', () => {
  it('names the path and the message, and why labels were left alone', () => {
    const report: Extract<HaltReport, { readonly kind: 'aborted' }> = { kind: 'aborted', reason: 'drain-unwritable', message: 'disk full', path: '/userData/dispatch.json' }
    expect(haltAbortedCopy(report)).toBe(
      "Nothing was halted — /userData/dispatch.json couldn't be written (disk full). Labels were left alone, because resetting them with dispatch still open would just start everything again.",
    )
  })
})
