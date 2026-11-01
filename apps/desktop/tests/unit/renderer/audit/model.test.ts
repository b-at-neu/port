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
    [{ kind: 'terminal-owned', since: 't' }, 'attention', 'Refused'],
    [{ kind: 'ownership-unreadable', path: 'p', message: 'm' }, 'attention', 'Refused'],
    [{ kind: 'unresolvable-label', keys: ['planApproved'] }, 'attention', 'Refused'],
    [{ kind: 'item-unavailable' }, 'attention', 'Refused'],
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
  it('names a conflict`s expected and observed labels', () => {
    const result = { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: ['paused'], observed: ['ready', 'claude'], readAt: 't' } } as const
    expect(detailOf(labelEntry({ result }))).toBe('Expected labels paused; found ready, claude.')
  })

  it('names a write failure`s classification and first stderr line', () => {
    const result = { kind: 'write-failed', classification: 'rate-limited', stderr: 'API rate limit exceeded\nretry later', reread: null } as const
    expect(detailOf(labelEntry({ result }))).toBe('rate-limited: API rate limit exceeded')
  })

  it('carries a verify failure message', () => {
    expect(detailOf(labelEntry({ result: { kind: 'verify-failed', message: 'still labelled' } }))).toBe('still labelled')
  })

  it.each([
    [{ kind: 'terminal-owned', since: '2026-01-01' }, 'A terminal cockpit has owned this repository since 2026-01-01.'],
    [{ kind: 'ownership-unreadable', path: '.agents/cockpit.json', message: 'EACCES' }, "Couldn't read .agents/cockpit.json: EACCES"],
    [{ kind: 'unresolvable-label', keys: ['planApproved', 'approved'] }, 'No label is configured for planApproved, approved.'],
    [{ kind: 'item-unavailable' }, "The item couldn't be read."],
  ] as const)('explains the %j refusal', (result, expected) => {
    expect(detailOf(labelEntry({ result }))).toBe(expected)
  })

  it('reports a comment`s byte count when the result has nothing to add', () => {
    expect(detailOf(labelEntry({ result: { kind: 'applied', argv: [] }, commentBytes: 212 }))).toBe('Comment of 212 bytes.')
  })

  it('is null for a plain applied or no-op write', () => {
    expect(detailOf(labelEntry({ result: { kind: 'applied', argv: [] } }))).toBeNull()
    expect(detailOf(labelEntry())).toBeNull()
  })

  it('counts a partial reclaim`s removed and failed worktrees', () => {
    expect(detailOf(reclaimEntry({ result: 'partial', removed: ['a'], failed: ['b', 'c'] }))).toBe('Removed 1, failed 2.')
  })

  it('is null for an applied reclaim', () => {
    expect(detailOf(reclaimEntry())).toBeNull()
  })
})
