// The Board's detail pane content, inside the shared `DetailPane` shell:
// title, phase pill, `PhaseList`, held detail, actions.
import { useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DetailPane } from '../components/detail-pane'
import { PhaseList } from '../components/phase-list'
import { StatusPill } from '../components/status-pill'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '../../../shared/actions/types'
import type { OperatorAction } from '../../../shared/actions/types'
import type { BoardItemRow } from '../../../shared/board/types'
import type { DispatchOwner } from '../../../shared/dispatch/types'
import type { TickReport } from '../../../shared/tick/types'
import { PHASE_NAMES } from '../lib/phase'
import { openDecision } from '../decision/controller'
import { openReviewDialog } from '../gate/controller'
import { itemActionState, runItemAction, subscribeItemActions } from './actions'
import { actionButtonLabel, actionPendingLabel, actionResultCopy, decisionButtonLabel, reviewPlanButtonLabel } from './copy'
import { actionNoteFor, agentSummaryOf, decisionNoteFor, pillStatusFor } from './row-model'
import { itemDetailLines } from './tick'

export interface ItemPaneProps {
  readonly row: BoardItemRow
  readonly report: TickReport | undefined
  readonly owner: DispatchOwner
  readonly onClose: () => void
}

function phaseLabel(row: BoardItemRow): string {
  return row.stageLabel !== null ? (PHASE_NAMES[row.stageLabel.key] ?? row.stageLabel.key) : 'Unstaged'
}

export function ItemPane({ row, report, owner, onClose }: ItemPaneProps) {
  const { item } = row
  const state = useSyncExternalStore(subscribeItemActions, () => itemActionState(item.repoId, item.number))
  const pendingAction = state?.kind === 'pending' ? state.action : null

  const heldLines = report !== undefined ? itemDetailLines(report, item.number, owner) : []
  const availableActions = OPERATOR_ACTIONS.filter((action) => row.actions[action].available)
  const availableDecisions = OPERATOR_DECISIONS.filter((decision) => row.decisions[decision].available)
  const agentSummary = agentSummaryOf(item.agents, item.sessions)

  async function handleAction(action: OperatorAction): Promise<void> {
    await runItemAction({ repoId: item.repoId, kind: item.kind, number: item.number, action, expectedStage: row.stageLabel?.key ?? null })
    const result = itemActionState(item.repoId, item.number)
    if (result?.kind === 'result' && !result.result.ok) {
      const availability = row.actions[action]
      toast(
        actionResultCopy({
          action,
          number: item.number,
          plan: availability.available ? availability.plan : null,
          currentStageName: row.stageLabel?.name ?? null,
          result: result.result,
          now: new Date(),
        }),
      )
    }
  }

  const note = actionNoteFor(row, state)
  const decisionNote = decisionNoteFor(row)

  return (
    <DetailPane onClose={onClose}>
      <div className="flex flex-col gap-1">
        <h2 className="text-title font-semibold text-foreground">{item.title}</h2>
        <div className="flex items-center gap-2 text-small text-muted-foreground">
          <span>#{item.number}</span>
          <span>{item.repo}</span>
        </div>
        <a href={item.url} target="_blank" rel="noreferrer" className="text-small text-primary-text hover:underline">
          {item.kind === 'issue' ? 'Open ticket' : 'Open PR'}
        </a>
      </div>
      <StatusPill status={pillStatusFor(row)} label={phaseLabel(row)} />
      <PhaseList stageKey={row.stageLabel?.key ?? null} kind={item.kind} merged={item.mergedAt !== null} currentDetail={agentSummary} />
      {heldLines.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-meta text-muted-foreground">
          {heldLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {availableActions.map((action) => (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <span>
                  <Button variant="outline" size="small" disabled={pendingAction !== null} onClick={() => void handleAction(action)}>
                    {pendingAction === action ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
                    {pendingAction === action ? actionPendingLabel(action) : actionButtonLabel(action)}
                  </Button>
                </span>
              </TooltipTrigger>
              {pendingAction !== null && pendingAction !== action ? <TooltipContent>Another action on #{item.number} is already in progress.</TooltipContent> : null}
            </Tooltip>
          ))}
          {availableDecisions.map((decision) => {
            const availability = row.decisions[decision]
            if (!availability.available) return null
            return (
              <Button
                key={decision}
                variant="outline"
                size="small"
                onClick={() => openDecision({ repoId: item.repoId, number: item.number, decision, expectedStage: row.stageLabel?.key ?? null, context: availability.context })}
              >
                {decisionButtonLabel(decision)}
              </Button>
            )
          })}
          {item.kind === 'issue' && row.stageLabel?.key === 'planReview' ? (
            <Button variant="outline" size="small" onClick={() => openReviewDialog(item.repoId, item.number)}>
              {reviewPlanButtonLabel()}
            </Button>
          ) : null}
        </div>
        {note !== null ? <p className="text-small text-muted-foreground">{note}</p> : null}
        {decisionNote !== null ? <p className="text-small text-muted-foreground">{decisionNote}</p> : null}
      </div>
    </DetailPane>
  )
}
