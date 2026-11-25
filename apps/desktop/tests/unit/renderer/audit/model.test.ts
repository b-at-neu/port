import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { AuditEntry, LabelAuditEntry, ReclaimAuditEntry } from '@/types/writes'
import { actorOf, auditRows, commandOf, detailOf, outcomeOf } from '@/renderer/audit/model'

const REPO_ID = 'repo-1' as unknown as RepoId

function labelEntry(overrides: Partial<LabelAuditEntry> = {}): LabelAuditEntry {
  return {
    at: '2026-01-01T00:00:00.000Z',
    repo: 'acme/widgets',
    repoId: REPO_ID,
    kind: 'issue',
    number: 38,
    action: 'pause',
    ownership: 'app',
    precondition: null,
    observed: null,
    call: null,
    commentBytes: null,
    result: { kind: 'no-op' },
    ...overrides,
  }
}

function reclaimEntry(overrides: Partial<ReclaimAuditEntry> = {}): ReclaimAuditEntry {
  return { at: '2026-01-01T00:00:00.000Z', repo: 'acme/widgets', repoId: REPO_ID, action: 'worktree-reclaim', issue: null, force: null, call: null, removed: [], failed: [], result: 'applied', failure: null, ...overrides }
}

describe('auditRows', () => {
  it('lists the newest entry first with a key per original position', () => {
    const entries: AuditEntry[] = [labelEntry({ at: '2026-01-01T00:00:00.000Z', action: 'pause' }), labelEntry({ at: '2026-01-01T00:05:00.000Z', action: 'resume' })]
    const rows = auditRows(entries)
    expect(rows.map((row) => row.action)).toEqual(['resume', 'pause'])
    expect(rows.map((row) => row.key)).toEqual(['1-2026-01-01T00:05:00.000Z', '0-2026-01-01T00:00:00.000Z'])
  })

  it('gives a label entry a target and a reclaim entry none', () => {
    const [reclaim, label] = auditRows([labelEntry({ kind: 'pull-request', number: 7 }), reclaimEntry()])
    expect(label?.target).toEqual({ kind: 'pull-request', number: 7 })
    expect(reclaim?.target).toBeNull()
  })
})

describe('actorOf', () => {
  it.each(['auto-approve-plan', 'budget-escalate', 'observe-refresh', 'observe-cycle-cap'])('reads %s as port', (action) => {
    expect(actorOf(action)).toBe('port')
  })

  it.each(['pause', 'unblock', 'stop', 'worktree-reclaim'])('reads %s as you', (action) => {
    expect(actorOf(action)).toBe('you')
  })
})

describe('outcomeOf', () => {
  it.each([
    [{ kind: 'applied', argv: [] }, 'success', 'Applied'],
    [{ kind: 'no-op' }, 'idle', 'No change'],
    [{ kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: 't' } }, 'danger', 'Conflict'],
    [{ kind: 'write-failed', classification: 'network', stderr: '', reread: null }, 'danger', 'Failed'],
    [{ kind: 'verify-failed', message: 'm' }, 'danger', 'Failed'],
    [{ kind: 'ownership-unreadable', path: 'p', message: 'm' }, 'attention', 'Refused'],
    [{ kind: 'unresolvable-label', keys: ['planApproved'] }, 'attention', 'Refused'],
    [{ kind: 'item-unavailable' }, 'attention', 'Refused'],
    [{ kind: 'state-unsaved', message: 'disk full' }, 'danger', 'Not saved'],
    [{ kind: 'mirror-failed', mirror: { kind: 'verify-failed', message: 'offline' } }, 'attention', 'Label not updated'],
  ] as const)('maps the %j write outcome', (result, tone, label) => {
    expect(outcomeOf(labelEntry({ result }))).toEqual({ tone, label })
  })

  it.each([
    ['applied', 'success', 'Applied'],
    ['partial', 'attention', 'Partial'],
    ['failed', 'danger', 'Failed'],
  ] as const)('maps the %s reclaim result', (result, tone, label) => {
    expect(outcomeOf(reclaimEntry({ result }))).toEqual({ tone, label })
  })
})

describe('commandOf', () => {
  it('is null without a call', () => {
    expect(commandOf(null)).toBeNull()
  })

  it('joins the argv and single-quotes an argument with whitespace or a quote', () => {
    expect(commandOf(['gh', 'issue', 'edit', '38', '--add-label', 'plan approved'])).toBe("gh issue edit 38 --add-label 'plan approved'")
    expect(commandOf(['echo', "it's"])).toBe("echo 'it'\\''s'")
  })
})

describe('detailOf', () => {
  it.each([
    ['a conflict', labelEntry({ result: { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: ['paused'], observed: ['ready'], readAt: 't' } } })],
    ['a write failure', labelEntry({ result: { kind: 'write-failed', classification: 'rate-limited', stderr: 'limit', reread: null } })],
    ['a verify failure', labelEntry({ result: { kind: 'verify-failed', message: 'still labelled' } })],
    ['an unreadable ownership file', labelEntry({ result: { kind: 'ownership-unreadable', path: 'p', message: 'EACCES' } })],
    ['an unresolvable label', labelEntry({ result: { kind: 'unresolvable-label', keys: ['planApproved'] } })],
    ['an unsaved state', labelEntry({ result: { kind: 'state-unsaved', message: 'disk full' } })],
    ['a failed mirror', labelEntry({ result: { kind: 'mirror-failed', mirror: { kind: 'verify-failed', message: 'offline' } } })],
    ['an unavailable item', labelEntry({ result: { kind: 'item-unavailable' } })],
    ['an applied write with a comment', labelEntry({ result: { kind: 'applied', argv: [] }, commentBytes: 212 })],
    ['a partial reclaim', reclaimEntry({ result: 'partial', removed: ['a'], failed: ['b'] })],
  ] as const)('explains %s', (_label, entry) => {
    expect(detailOf(entry)).not.toBeNull()
  })

  it.each([
    ['an applied write', labelEntry({ result: { kind: 'applied', argv: [] } })],
    ['a no-op write', labelEntry()],
    ['an applied reclaim', reclaimEntry()],
  ] as const)('has nothing to add for %s', (_label, entry) => {
    expect(detailOf(entry)).toBeNull()
  })
})
