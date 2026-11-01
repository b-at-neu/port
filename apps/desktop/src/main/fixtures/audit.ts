// Fixture mode's own canned audit log: one entry per row shape the Audit screen renders.
import type { IpcMap } from '@/types/ipc'
import type { FixtureScenario } from '@/types/fixtures'
import type { AuditEntry, AuditRead, LabelAuditEntry } from '@/types/writes'
import { isLabelAuditEntry } from '@/types/writes'
import { WIDGETS_ID } from '@/main/fixtures/repos'

const REPO = 'acme/widgets'

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function labelEntry(now: Date, minutes: number, number: number, action: string, call: readonly string[] | null, result: LabelAuditEntry['result'], commentBytes: number | null = null): LabelAuditEntry {
  return {
    at: minutesAgo(now, minutes),
    repo: REPO,
    repoId: WIDGETS_ID,
    kind: 'issue',
    number,
    action,
    ownership: 'app',
    precondition: null,
    observed: null,
    call,
    commentBytes,
    result,
  }
}

function cannedEntries(now: Date): readonly AuditEntry[] {
  const edit = (number: number): readonly string[] => ['gh', 'issue', 'edit', String(number), '--repo', REPO]
  const comment = ['gh', 'issue', 'comment', '41', '--repo', REPO, '--body-file', 'comment.md']
  return [
    {
      at: minutesAgo(now, 2880),
      repoId: WIDGETS_ID,
      repo: REPO,
      action: 'worktree-reclaim',
      issue: null,
      force: null,
      call: ['node', 'plugins/port/bin/worktrees.mjs', 'reclaim'],
      removed: ['impl-30'],
      failed: ['impl-33'],
      result: 'partial',
      failure: null,
    },
    labelEntry(now, 1440, 41, 'unblock', comment, { kind: 'applied', argv: comment }, 212),
    labelEntry(now, 360, 38, 'auto-approve-plan', edit(38), { kind: 'applied', argv: edit(38) }),
    labelEntry(now, 240, 41, 'observe-refresh', edit(41), { kind: 'applied', argv: edit(41) }),
    labelEntry(now, 180, 38, 'pause', edit(38), { kind: 'applied', argv: edit(38) }),
    labelEntry(now, 120, 38, 'resume', null, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: ['paused'], observed: ['ready'], readAt: minutesAgo(now, 120) } }),
    labelEntry(now, 60, 41, 'retry', null, { kind: 'no-op' }),
    labelEntry(now, 15, 41, 'stop', edit(41), { kind: 'verify-failed', message: 'The re-read still showed the old labels.' }),
  ]
}

export function fixtureAuditRead(now: Date, scenario: FixtureScenario, request: IpcMap['audit:list']['request']): AuditRead {
  if (scenario === 'empty') return { ok: true, entries: [], malformed: 0, previousPath: null, readAt: now.toISOString() }

  const entries = cannedEntries(now).filter(
    (entry) => (request.repoId === null || entry.repoId === request.repoId) && (request.number === null || (isLabelAuditEntry(entry) && entry.number === request.number)),
  )
  return { ok: true, entries, malformed: 1, previousPath: '/fixture/userData/writes.prev.jsonl', readAt: now.toISOString() }
}
