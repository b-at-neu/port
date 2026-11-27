// One key per event, so a dismissal hides that event for good while a new event on the same ticket
// still shows. The switch is exhaustive: a new kind is a compile error, never an undismissable row.
import type { BoardItemRow, NeedsYouItem } from '@/types/board'
import { stageGroupOf } from '@/utils/pipeline/stages'

/** When the ticket last moved, or last moved into its current stage when `inCurrentStage`. */
function newestMoveAt(row: BoardItemRow | null, inCurrentStage = false): string {
  const ticket = row?.item.ticket
  const moves = (ticket?.history ?? []).filter((event) => event.to !== null && (!inCurrentStage || event.to.stage === ticket?.stage))
  return moves[moves.length - 1]?.at ?? ''
}

function eventOf(item: NeedsYouItem): string {
  switch (item.kind) {
    case 'plan-review':
    case 'ready-to-merge':
    case 'needs-human':
    case 'blocked':
      return newestMoveAt(item.row, true)
    case 'stage-interrupted':
      return `${item.interrupted.id}@${item.interrupted.interruptedAt}`
    case 'usage-limit':
      return `${item.resetsAt ?? ''}|${item.entries.map((entry) => entry.id).sort().join(',')}`
    case 'stage-denial':
      return item.denial.id
    case 'stage-question':
    case 'stage-approval':
      return item.permissionId
    case 'stage-questions':
      return `${item.sessionKey}@${item.at ?? ''}`
    case 'held':
      return `${item.held.reason}|${item.matchedRow?.item.headRefOid ?? ''}|${String(item.held.contention?.blocker ?? '')}`
    case 'stalled':
      return `${item.claim.class}|${newestMoveAt(item.matchedRow)}`
    case 'budget':
      return `${item.note.kind}|${newestMoveAt(item.matchedRow)}`
    case 'half-labelled':
      return item.repair.shape === 'mirror-failed' ? `mirror-failed|${item.repair.mirror?.at ?? ''}` : `${item.repair.shape}|${stageGroupOf(item.repair.view).key}`
    case 'dispatch-failed':
      return `${item.record.agent}|${item.record.detail ?? ''}`
  }
}

/** `dismissKeyOf(item)` — `kind:repoId:number:<event>`; the event part is each kind's own identity of "this occurrence". */
export function dismissKeyOf(item: NeedsYouItem): string {
  return `${item.kind}:${item.repoId ?? ''}:${item.number === null ? '' : String(item.number)}:${eventOf(item)}`
}
