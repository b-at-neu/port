// Never guessed: an unrecoverable inverse is reported rather than assumed.
import { RETRY_TRIGGER, pausedTriggerFrom } from '@/utils/actions/plan'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { AuditEntry, LabelAuditEntry } from '@/types/writes'
import { isLabelAuditEntry } from '@/types/writes'
import { readAuditLog } from '@/main/writes/audit'
import type { RecoverPausedTriggerParams, RecoverPausedTriggerResult } from '@/types/actions'

function isAppliedPauseOrStop(entry: AuditEntry): entry is LabelAuditEntry {
  if (!isLabelAuditEntry(entry)) return false
  return (entry.action === 'pause' || entry.action === 'stop') && entry.result.kind === 'applied'
}

/** `pause` removes a trigger-role key directly; `stop` removes an in-flight-role key, mapped
 *  forward through `RETRY_TRIGGER` before `resume` can restore it. */
function roleOf(key: LabelKey): string | null {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.role ?? null
}

// `readAuditLog` returns entries oldest-first, so the *last* match is the most recent pause or stop.
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
