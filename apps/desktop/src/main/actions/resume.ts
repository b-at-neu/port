// The recovery half of resume (#94): reads the audit log for the last pause
// applied against this item and resolves the trigger it removed. Never
// guessed — restoring `ready` on an item that was at `plan approved` would
// send it back through planning, so an unrecoverable inverse is reported
// rather than assumed.
import { pausedTriggerFrom } from '../../shared/actions/plan'
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import type { AuditEntry, AuditRead } from '../../shared/writes/types'
import { readAuditLog } from '../writes'

export type RecoverPausedTriggerResult = { readonly kind: 'recovered'; readonly trigger: LabelKey } | { readonly kind: 'no-record' } | { readonly kind: 'unresolvable' }

export interface RecoverPausedTriggerParams {
  readonly auditDir: string
  readonly repo: string
  readonly number: number
  readonly vocabulary: LabelVocabulary
  readonly readAuditLog?: (dir: string, params: { readonly repo?: string; readonly number?: number }) => Promise<AuditRead>
}

function isAppliedPause(entry: AuditEntry): boolean {
  return entry.action === 'pause' && entry.result.kind === 'applied'
}

/**
 * `readAuditLog` returns entries oldest-first (its own append order), so the
 * *last* one matching is the most recent pause. No such entry — including an
 * unreadable log, which carries no provable pause either — reports
 * `no-record`; a recorded name that no longer resolves to a `LabelKey`
 * reports `unresolvable`. Neither is guessed.
 */
export async function recoverPausedTrigger(params: RecoverPausedTriggerParams): Promise<RecoverPausedTriggerResult> {
  const read = params.readAuditLog ?? readAuditLog
  const result = await read(params.auditDir, { repo: params.repo, number: params.number })
  if (!result.ok) return { kind: 'no-record' }

  const lastPause = result.entries.findLast(isAppliedPause)
  if (lastPause === undefined) return { kind: 'no-record' }

  const trigger = pausedTriggerFrom(lastPause, params.vocabulary)
  return trigger === null ? { kind: 'unresolvable' } : { kind: 'recovered', trigger }
}
