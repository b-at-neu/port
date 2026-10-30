// Pure operator-join read over dispatch records — renderer-safe, no I/O.
import type { DispatchRecord } from '@/types/dispatch'
import type { StageLinkTarget } from '@/types/board'

function matchesAny(record: DispatchRecord, targets: readonly StageLinkTarget[]): boolean {
  return targets.some((target) => record.number === target.number && record.kind === target.kind)
}

/** `true` when any matching record carries an operator join. */
export function operatorJoinedOf(records: readonly DispatchRecord[], targets: readonly StageLinkTarget[]): boolean {
  return records.filter((r) => matchesAny(r, targets)).some((r) => r.operatorJoinedAt !== null)
}
