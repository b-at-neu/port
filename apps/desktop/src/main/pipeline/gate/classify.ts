// Pure plan-review-gate classification — no `gh`, no filesystem. The caller supplies the already-fetched `GateClassifyItem`; this module never touches a body string.
import type { GateVerdict } from '@/types/gate'
import type { GateClassifyItem } from '@/types/gate'
import { stageNameOf, ticketViewOf } from '@/utils/pipeline/stages'

/** `item: null` passes through as `not-found`, never a thrown error. The gate is open when the ticket is at `plan` and waiting on the plan-approval gate. `assignedElsewhere` is advisory only, never a refusal. */
export function classifyGate(params: { readonly item: GateClassifyItem | null }): GateVerdict {
  const { item } = params
  if (item === null) return { kind: 'not-found' }
  if (item.kind === 'pull-request') return { kind: 'not-an-issue' }

  const { ticket } = item
  if (ticket === null || ticket.stage !== 'plan' || ticket.status.kind !== 'waiting-on-you' || ticket.status.gate !== 'plan-approval') {
    return { kind: 'not-at-plan-review', observed: ticket === null ? null : stageNameOf(ticketViewOf(ticket)) }
  }

  const assignedElsewhere = item.assignees.filter((login) => login !== item.viewer)
  return { kind: 'answerable', noPlanBlock: item.noPlanBlock, assignedElsewhere }
}
