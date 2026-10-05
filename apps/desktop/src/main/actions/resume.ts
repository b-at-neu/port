// The recovery half of resume (#94, widened for stop by #110): reads the
// audit log for the last pause or stop applied against this item and
// resolves the trigger it should restore. Never guessed — restoring `ready`
// on an item that was at `plan approved` would send it back through
// planning, so an unrecoverable inverse is reported rather than assumed.
import { RETRY_TRIGGER, pausedTriggerFrom } from '../../shared/actions/plan'
import { LABEL_DEFAULTS } from '../../shared/labels/defaults'
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import type { AuditEntry, AuditRead } from '../../shared/writes/types'
import { readAuditLog } from '../writes/audit'

export type RecoverPausedTriggerResult = { readonly kind: 'recovered'; readonly trigger: LabelKey } | { readonly kind: 'no-record' } | { readonly kind: 'unresolvable' }

export interface RecoverPausedTriggerParams {
  readonly auditDir: string
  readonly repo: string
  readonly number: number
  readonly vocabulary: LabelVocabulary
  readonly readAuditLog?: (dir: string, params: { readonly repo?: string; readonly number?: number }) => Promise<AuditRead>
}

function isAppliedPauseOrStop(entry: AuditEntry): boolean {
  return (entry.action === 'pause' || entry.action === 'stop') && entry.result.kind === 'applied'
}

/** `pause` removes a trigger-role key directly; `stop` (#110) removes an
 *  in-flight-role key instead, which must be mapped forward through
 *  `RETRY_TRIGGER` before it is a trigger `resume` can restore. Read off
 *  `LABEL_DEFAULTS` rather than re-derived, so a role addition or rename
 *  there is the one place this ever has to change. */
function roleOf(key: LabelKey): string | null {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.role ?? null
}

/**
 * `readAuditLog` returns entries oldest-first (its own append order), so the
 * *last* one matching is the most recent pause or stop. No such entry —
 * including an unreadable log, which carries no provable one either —
 * reports `no-record`. A recorded name that no longer resolves to a
 * `LabelKey` at all is `unresolvable`; a resolved key with neither a
 * trigger role nor an in-flight role that maps through `RETRY_TRIGGER` is
 * `unresolvable` too, rather than a guess.
 */
export async function recoverPausedTrigger(params: RecoverPausedTriggerParams): Promise<RecoverPausedTriggerResult> {
  const read = params.readAuditLog ?? readAuditLog
  const result = await read(params.auditDir, { repo: params.repo, number: params.number })
  if (!result.ok) return { kind: 'no-record' }

  const lastEntry = result.entries.findLast(isAppliedPauseOrStop)
  if (lastEntry === undefined) return { kind: 'no-record' }

  const recorded = pausedTriggerFrom(lastEntry, params.vocabulary)
  if (recorded === null) return { kind: 'unresolvable' }

  const role = roleOf(recorded)
  if (role === 'trigger') return { kind: 'recovered', trigger: recorded }
  if (role === 'in-flight') {
    const mapped = RETRY_TRIGGER[recorded]
    return mapped !== undefined ? { kind: 'recovered', trigger: mapped } : { kind: 'unresolvable' }
  }
  return { kind: 'unresolvable' }
}
