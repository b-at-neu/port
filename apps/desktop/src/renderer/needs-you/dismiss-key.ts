// One key per event, so a dismissal hides that event for good while a new event on the same ticket
// still shows. The switch is exhaustive: a new kind is a compile error, never an undismissable row.
import type { BoardItemRow, NeedsYouItem } from '@/types/board'

function newestStageAt(row: BoardItemRow | null, stageKey?: string): string {
  const history = row?.item.stageHistory ?? []
  const matching = stageKey === undefined ? history : history.filter((entry) => entry.key === stageKey)
  return matching[matching.length - 1]?.at ?? ''
}

function eventOf(item: NeedsYouItem): string {
  switch (item.kind) {
    case 'plan-review':
    case 'ready-to-merge':
    case 'needs-human':
    case 'blocked':
      return newestStageAt(item.row, item.row.stageLabel?.key)
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
    case 'stage-blocked':
      return `${item.sessionKey}@${item.at ?? ''}`
    case 'held':
      return `${item.held.reason}|${item.matchedRow?.item.headRefOid ?? ''}|${String(item.held.contention?.blocker ?? '')}`
    case 'stalled':
      return `${item.claim.class}|${newestStageAt(item.matchedRow)}`
    case 'budget':
      return `${item.note.kind}|${newestStageAt(item.matchedRow)}`
    case 'half-labelled':
      return `${item.repair.shape}|${[...item.repair.labels].sort().join(',')}`
  }
}

/** `dismissKeyOf(item)` — `kind:repoId:number:<event>`; the event part is each kind's own identity of "this occurrence". */
export function dismissKeyOf(item: NeedsYouItem): string {
  return `${item.kind}:${item.repoId ?? ''}:${item.number === null ? '' : String(item.number)}:${eventOf(item)}`
}
