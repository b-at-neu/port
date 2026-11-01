// The one `AuditEntry` → row mapping — pure, no DOM.
import type { AuditEntry, AuditRowView, LabelAuditEntry, PurgeAuditEntry, ReclaimAuditEntry } from '@/types/writes'
import type { ReleaseAuditEntry } from '@/types/release'
import { isAllowAuditEntry, isLabelAuditEntry, isPurgeAuditEntry, isReleaseAuditEntry } from '@/types/writes'

type Outcome = AuditRowView['outcome']

const AUTOMATIC_ACTIONS: ReadonlySet<string> = new Set(['auto-approve-plan', 'budget-escalate'])

export function actorOf(action: string): AuditRowView['actor'] {
  return AUTOMATIC_ACTIONS.has(action) || action.startsWith('observe-') ? 'port' : 'you'
}

function reclaimOutcome(result: ReclaimAuditEntry['result']): Outcome {
  switch (result) {
    case 'applied':
      return { tone: 'success', label: 'Applied' }
    case 'partial':
      return { tone: 'attention', label: 'Partial' }
    case 'failed':
      return { tone: 'danger', label: 'Failed' }
  }
}

function purgeOutcome(result: PurgeAuditEntry['result']): Outcome {
  switch (result) {
    case 'deleted':
      return { tone: 'success', label: 'Applied' }
    case 'refused':
      return { tone: 'attention', label: 'Refused' }
    case 'failed':
      return { tone: 'danger', label: 'Failed' }
  }
}

function labelOutcome(result: LabelAuditEntry['result']): Outcome {
  switch (result.kind) {
    case 'applied':
      return { tone: 'success', label: 'Applied' }
    case 'no-op':
      return { tone: 'idle', label: 'No change' }
    case 'precondition-failed':
      return { tone: 'danger', label: 'Conflict' }
    case 'write-failed':
    case 'verify-failed':
      return { tone: 'danger', label: 'Failed' }
    case 'terminal-owned':
    case 'ownership-unreadable':
    case 'unresolvable-label':
    case 'item-unavailable':
      return { tone: 'attention', label: 'Refused' }
  }
}

function releaseOutcome(result: ReleaseAuditEntry['result']): Outcome {
  return result === 'applied' ? { tone: 'success', label: 'Applied' } : { tone: 'danger', label: 'Failed' }
}

export function outcomeOf(entry: AuditEntry): Outcome {
  if (isLabelAuditEntry(entry)) return labelOutcome(entry.result)
  if (isPurgeAuditEntry(entry)) return purgeOutcome(entry.result)
  if (isAllowAuditEntry(entry)) return releaseOutcome(entry.result)
  return isReleaseAuditEntry(entry) ? releaseOutcome(entry.result) : reclaimOutcome(entry.result)
}

function quoted(arg: string): string {
  return /[\s'"]/.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg
}

export function commandOf(call: readonly string[] | null): string | null {
  return call === null ? null : call.map(quoted).join(' ')
}

function listOf(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ')
}

function resultDetail(result: LabelAuditEntry['result']): string | null {
  switch (result.kind) {
    case 'precondition-failed':
      return result.conflict.kind === 'precondition-failed' ? `Expected labels ${listOf(result.conflict.expected)}; found ${listOf(result.conflict.observed)}.` : null
    case 'write-failed':
      return `${result.classification}: ${result.stderr.split('\n')[0] ?? ''}`.trimEnd()
    case 'verify-failed':
      return result.message
    case 'terminal-owned':
      return `A terminal cockpit has owned this repository since ${result.since}.`
    case 'ownership-unreadable':
      return `Couldn't read ${result.path}: ${result.message}`
    case 'unresolvable-label':
      return `No label is configured for ${result.keys.join(', ')}.`
    case 'item-unavailable':
      return "The item couldn't be read."
    case 'applied':
    case 'no-op':
      return null
  }
}

export function detailOf(entry: AuditEntry): string | null {
  if (isPurgeAuditEntry(entry)) return entry.failure === null ? `Directory ${entry.path}.` : `Directory ${entry.path}. ${entry.failure}`
  if (isAllowAuditEntry(entry)) return entry.failure === null ? `Allow ${entry.rule}.` : `Allow ${entry.rule}. ${entry.failure}`
  if (isReleaseAuditEntry(entry)) return entry.failure === null ? `Release v${entry.version}.` : `Release v${entry.version}. ${entry.failure}`
  if (!isLabelAuditEntry(entry)) {
    const counts = `Removed ${String(entry.removed.length)}, failed ${String(entry.failed.length)}.`
    return entry.result === 'applied' ? null : entry.failure === null ? counts : `${counts} ${entry.failure}`
  }
  const fromResult = resultDetail(entry.result)
  if (fromResult !== null) return fromResult
  return entry.commentBytes === null ? null : `Comment of ${String(entry.commentBytes)} bytes.`
}

function rowOf(entry: AuditEntry, index: number): AuditRowView {
  return {
    key: `${String(index)}-${entry.at}`,
    at: entry.at,
    repo: entry.repo,
    repoId: entry.repoId,
    target: isLabelAuditEntry(entry) ? { kind: entry.kind, number: entry.number } : null,
    actor: actorOf(entry.action),
    action: entry.action,
    outcome: outcomeOf(entry),
    command: commandOf(entry.call),
    detail: detailOf(entry),
  }
}

/** The read is oldest-first; the screen shows newest-first. */
export function auditRows(entries: readonly AuditEntry[]): readonly AuditRowView[] {
  return entries.map(rowOf).reverse()
}
