// The Board's detail pane content, inside the shared `DetailPane` shell:
// header, actions and decisions, `PhaseList` with its session links, held detail.
import { useSyncExternalStore } from 'react'
import { Loader2, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { DetailPane } from '@/renderer/components/detail-pane'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { PaneCloseButton } from '@/renderer/components/pane-close-button'
import { PhaseList } from '@/renderer/components/phase-list'
import { PhasePill } from '@/renderer/components/phase-pill'
import { SessionLinkRow } from '@/renderer/components/session-link-row'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { OperatorAction } from '@/types/actions'
import type { BoardItemRow, TicketSessionLink } from '@/types/board'
import type { DispatchOwner } from '@/types/dispatch'
import type { TickReport } from '@/types/tick'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { openDecision } from '@/renderer/decision/controller'
import { openReviewDialog } from '@/renderer/gate/controller'
import { itemActionState, runItemAction, subscribeItemActions } from '@/renderer/board/actions'
import { actionButtonLabel, actionPendingLabel, actionResultCopy, decisionButtonLabel, openPrLinkLabel, openTicketLinkLabel, reviewPlanButtonLabel, writeHistoryLinkLabel } from '@/renderer/board/copy'
import { yourSessionsLabel } from '@/renderer/board/session-copy'
import { actionNoteFor, agentSummaryOf, decisionNoteFor, phaseLabelFor, phaseToneFor, stageTargetsOf } from '@/renderer/board/row-model'
import { itemDetailLines } from '@/renderer/board/tick'
import { phaseDetailsFor } from '@/renderer/board/phase-history'
import { currentPhaseFor } from '@/renderer/board/phase-model'
import { ticketSessionsFor } from '@/renderer/board/ticket-sessions'
import { useIpcQuery } from '@/renderer/data/query'
import { prSuffixOf } from '@/utils/tickets/ticket'

interface ItemPaneProps {
  readonly row: BoardItemRow
  readonly report: TickReport | undefined
  readonly owner: DispatchOwner
  readonly onClose: () => void
}

export function ItemPane({ row, report, owner, onClose }: ItemPaneProps) {
  const { item, ticket } = row
  const navigate = useNavigate()
  const state = useSyncExternalStore(subscribeItemActions, () => itemActionState(item.repoId, item.number))
  const pendingAction = state?.kind === 'pending' ? state.action : null

  const heldLines = report !== undefined ? itemDetailLines(report, item.number, owner) : []
  const availableActions = OPERATOR_ACTIONS.filter((action) => row.actions[action].available)
  const availableDecisions = OPERATOR_DECISIONS.filter((decision) => row.decisions[decision].available)
  const agentSummary = agentSummaryOf(item.agents, item.sessions)

  const liveSessions = useIpcQuery('session:list')
  const sessionIndex = useIpcQuery('session:index')
  const now = new Date()
  const ticketSessions = ticketSessionsFor({
    repoId: item.repoId,
    targets: stageTargetsOf(row),
    index: sessionIndex.data ?? [],
    snapshots: liveSessions.data ?? [],
    issue: ticket.issue,
    pullRequest: ticket.pullRequest,
  })
  const currentPhase = currentPhaseFor({ stageKey: row.stageLabel?.key ?? null, kind: item.kind })
  const liveStageLink = currentPhase === null ? undefined : (ticketSessions.byPhase[currentPhase] ?? []).findLast((link) => link.state === 'live' && link.who.kind === 'stage')
  const phaseDetails = phaseDetailsFor({
    history: item.stageHistory,
    kind: item.kind,
    stageKey: row.stageLabel?.key ?? null,
    merged: item.mergedAt !== null,
    viewer: row.viewer,
    now,
    currentCostUsd: liveStageLink?.costUsd ?? null,
  })

  function openSession(link: TicketSessionLink): void {
    if (link.open.kind === 'session') {
      void navigate({ to: ROUTE_IDS.session, search: { key: link.open.sessionKey, pane: null } })
      return
    }
    void navigate({
      to: ROUTE_IDS.transcript,
      params: { sessionId: link.open.sessionId },
      search: { agentId: link.open.agentId, from: 'board', focusIndex: null, title: ticket.ref.title, item: null },
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
          number: ticket.ref.number,
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
  const prSuffix = prSuffixOf(ticket.ref)

  return (
    <DetailPane onClose={onClose}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-title font-semibold text-foreground">{ticket.ref.title}</h2>
          <PaneCloseButton label="Close details" onClick={onClose} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
          <span>
            {ticket.ref.kind === 'issue' ? '#' : 'PR#'}
            {ticket.ref.number}
            {prSuffix !== null ? ` ${prSuffix}` : ''}
          </span>
          <span>{item.repo}</span>
          <PhasePill tone={phaseToneFor(row)} label={phaseLabelFor(row)} />
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
              {pendingAction !== null && pendingAction !== action ? <TooltipContent>Another action on #{ticket.ref.number} is already in progress.</TooltipContent> : null}
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
      <PhaseList
        stageKey={row.stageLabel?.key ?? null}
        kind={item.kind}
        merged={item.mergedAt !== null}
        details={phaseDetails}
        extraCurrentLine={agentSummary}
        sessions={ticketSessions.byPhase}
        now={now}
        onOpenSession={openSession}
      />
      {sessionIndex.isPending ? <Skeleton className="h-3 w-32" /> : null}
      {sessionIndex.isError ? <ErrorBanner message="Couldn't load past sessions. Live sessions still show." /> : null}
      {ticketSessions.unplaced.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-meta text-muted-foreground">{yourSessionsLabel()}</span>
          {ticketSessions.unplaced.map((link) => (
            <SessionLinkRow key={link.key} link={link} now={now} onOpen={openSession} />
          ))}
        </div>
      ) : null}
      <Button variant="ghost" size="small" className="self-start" onClick={() => void navigate({ to: ROUTE_IDS.audit, search: { repo: item.repoId, number: item.number } })}>
        <ScrollText aria-hidden="true" className="size-3.5" />
        {writeHistoryLinkLabel()}
      </Button>
      {heldLines.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-meta text-muted-foreground">
          {heldLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
    </DetailPane>
  )
}
