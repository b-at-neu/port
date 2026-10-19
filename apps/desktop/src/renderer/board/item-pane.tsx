// The Board's detail pane content, inside the shared `DetailPane` shell:
// title, phase pill, `PhaseList`, held detail, actions.
import { useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { DetailPane } from '@/renderer/components/detail-pane'
import { PhaseList } from '@/renderer/components/phase-list'
import { StatusPill } from '@/renderer/components/status-pill'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { OperatorAction } from '@/types/actions'
import type { BoardItemRow } from '@/types/board'
import { stageLinksFor } from '@/renderer/board/stage-links'
import type { StageLink } from '@/types/board'
import type { DispatchOwner, DispatchRecord } from '@/types/dispatch'
import type { TickReport } from '@/types/tick'
import { PHASE_NAMES } from '@/renderer/lib/phase'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { openDecision } from '@/renderer/decision/controller'
import { openReviewDialog } from '@/renderer/gate/controller'
import { itemActionState, runItemAction, subscribeItemActions } from '@/renderer/board/actions'
import { actionButtonLabel, actionPendingLabel, actionResultCopy, decisionButtonLabel, openPrLinkLabel, openTicketLinkLabel, reviewPlanButtonLabel, stageLinkLabel, stageSessionsSectionLabel } from '@/renderer/board/copy'
import { actionNoteFor, agentSummaryOf, decisionNoteFor, pillStatusFor, stageTargetsOf } from '@/renderer/board/row-model'
import { itemDetailLines } from '@/renderer/board/tick'
import { phaseDetailsFor } from '@/renderer/board/phase-history'
import { useIpcQuery } from '@/renderer/data/query'

interface ItemPaneProps {
  readonly row: BoardItemRow
  readonly report: TickReport | undefined
  readonly owner: DispatchOwner
  /** This item's repository's own dispatch records — `[]` for a repository this app doesn't dispatch. */
  readonly records: readonly DispatchRecord[]
  readonly onClose: () => void
}

function phaseLabel(row: BoardItemRow): string {
  return row.stageLabel !== null ? (PHASE_NAMES[row.stageLabel.key] ?? row.stageLabel.key) : 'Unstaged'
}

export function ItemPane({ row, report, owner, records, onClose }: ItemPaneProps) {
  const { item, ticket } = row
  const navigate = useNavigate()
  const state = useSyncExternalStore(subscribeItemActions, () => itemActionState(item.repoId, item.number))
  const pendingAction = state?.kind === 'pending' ? state.action : null

  const heldLines = report !== undefined ? itemDetailLines(report, item.number, owner) : []
  const availableActions = OPERATOR_ACTIONS.filter((action) => row.actions[action].available)
  const availableDecisions = OPERATOR_DECISIONS.filter((decision) => row.decisions[decision].available)
  const agentSummary = agentSummaryOf(item.agents, item.sessions)
  const stageLinks = stageLinksFor(records, stageTargetsOf(row))

  const sessions = useIpcQuery('session:list')
  const liveLink = stageLinks.find((link): link is Extract<StageLink, { readonly kind: 'live' }> => link.kind === 'live')
  const liveSnapshot = liveLink !== undefined ? ((sessions.data ?? []).find((snapshot) => snapshot.sessionKey === liveLink.sessionKey) ?? null) : null
  const currentCostUsd = liveSnapshot?.usage?.costUsd ?? null
  const now = new Date()
  const phaseDetails = phaseDetailsFor({
    history: item.stageHistory,
    kind: item.kind,
    stageKey: row.stageLabel?.key ?? null,
    merged: item.mergedAt !== null,
    viewer: row.viewer,
    now,
    currentCostUsd,
  })

  function openStageLink(link: StageLink): void {
    if (link.kind === 'live') {
      void navigate({ to: ROUTE_IDS.session, search: { key: link.sessionKey, pane: null } })
      return
    }
    void navigate({
      to: ROUTE_IDS.transcript,
      params: { sessionId: link.sessionId },
      search: { agentId: null, from: 'board', focusIndex: null, title: ticket.ref.title, item: null },
    })
  }

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
        <h2 className="text-title font-semibold text-foreground">{ticket.ref.title}</h2>
        <div className="flex items-center gap-2 text-small text-muted-foreground">
          <span>
            {ticket.ref.kind === 'issue' ? '#' : 'PR#'}
            {ticket.ref.number}
          </span>
          <span>{item.repo}</span>
        </div>
        <div className="flex items-center gap-3 text-small">
          {ticket.issue !== null ? (
            <a href={ticket.issue.url} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
              {openTicketLinkLabel()}
            </a>
          ) : null}
          {ticket.pullRequest !== null ? (
            <a href={ticket.pullRequest.url} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
              {openPrLinkLabel(ticket.issue !== null ? ticket.pullRequest.number : null)}
            </a>
          ) : null}
        </div>
      </div>
      <StatusPill status={pillStatusFor(row)} label={phaseLabel(row)} />
      <PhaseList stageKey={row.stageLabel?.key ?? null} kind={item.kind} merged={item.mergedAt !== null} details={phaseDetails} extraCurrentLine={agentSummary} />
      {stageLinks.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-meta text-muted-foreground">{stageSessionsSectionLabel()}</span>
          {stageLinks.map((link) => (
            <button
              key={link.kind === 'live' ? link.sessionKey : `${link.sessionId}-${link.at}`}
              type="button"
              onClick={() => openStageLink(link)}
              className="text-left text-small text-primary-text hover:underline"
            >
              {stageLinkLabel(link)}
            </button>
          ))}
        </div>
      ) : null}
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
