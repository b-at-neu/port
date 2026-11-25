// The Board's detail pane content, inside the shared `DetailPane` shell:
// header, actions and decisions, `PhaseList` with its session links, held detail.
import { Loader2, ScrollText } from 'lucide-react'
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
import type { BoardItemRow, TicketSessionLink } from '@/types/board'
import type { DispatchOwner } from '@/types/dispatch'
import type { TickReport } from '@/types/tick'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { openDecision } from '@/renderer/decision/controller'
import { openReviewDialog } from '@/renderer/gate/controller'
import { useItemAction } from '@/renderer/board/actions'
import {
  ACTION_BUTTON_LABELS,
  ACTION_PENDING_LABELS,
  CLOSE_DETAILS_LABEL,
  DECISION_BUTTON_LABELS,
  OPEN_TICKET_LABEL,
  PAST_SESSIONS_UNREADABLE,
  REVIEW_PLAN_LABEL,
  WRITE_HISTORY_LABEL,
  YOUR_SESSIONS_LABEL,
  actionInProgressTooltip,
  openPrLinkLabel,
} from '@/renderer/board/copy'
import { BlockedOnDetail } from '@/renderer/board/blocked-on-detail'
import { actionNoteFor, agentSummaryOf, decisionNoteFor, phaseLabelFor, phaseToneFor, stageTargetsOf } from '@/renderer/board/row-model'
import { itemDetailLines } from '@/renderer/board/tick'
import { phaseDetailsFor } from '@/renderer/board/phase-history'
import { ticketViewOf } from '@/renderer/lib/ticket-view'
import { needsYouKindOf, phaseOf } from '@/utils/pipeline/stages'
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
  const { state, run } = useItemAction(row)
  const pendingAction = state?.kind === 'pending' ? state.action : null

  const heldLines = report !== undefined ? itemDetailLines(report, item.number, owner) : []
  const availableActions = OPERATOR_ACTIONS.filter((action) => row.actions[action].available)
  const availableDecisions = OPERATOR_DECISIONS.filter((decision) => row.decisions[decision].available)
  const agentSummary = agentSummaryOf(item.agents, item.sessions)

  const liveSessions = useIpcQuery('session.list')
  const sessionIndex = useIpcQuery('session.index')
  const now = new Date()
  const ticketSessions = ticketSessionsFor({
    repoId: item.repoId,
    targets: stageTargetsOf(row),
    index: sessionIndex.data ?? [],
    snapshots: liveSessions.data ?? [],
    issue: ticket.issue,
    pullRequest: ticket.pullRequest,
  })
  const view = ticketViewOf(item)
  const currentPhase = phaseOf(view)
  const liveStageLink = currentPhase === null ? undefined : (ticketSessions.byPhase[currentPhase] ?? []).findLast((link) => link.state === 'live' && link.who.kind === 'stage')
  const phaseDetails = phaseDetailsFor({
    history: item.stageHistory,
    kind: item.kind,
    view,
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

  const note = actionNoteFor(row, state)
  const decisionNote = decisionNoteFor(row)
  const prSuffix = prSuffixOf(ticket.ref)

  return (
    <DetailPane onClose={onClose}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-title font-semibold text-foreground">{ticket.ref.title}</h2>
          <PaneCloseButton label={CLOSE_DETAILS_LABEL} onClick={onClose} />
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
              {OPEN_TICKET_LABEL}
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
                  <Button variant="outline" size="small" disabled={pendingAction !== null} onClick={() => void run(action)}>
                    {pendingAction === action ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
                    {pendingAction === action ? ACTION_PENDING_LABELS[action] : ACTION_BUTTON_LABELS[action]}
                  </Button>
                </span>
              </TooltipTrigger>
              {pendingAction !== null && pendingAction !== action ? <TooltipContent>{actionInProgressTooltip(ticket.ref.number)}</TooltipContent> : null}
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
                {DECISION_BUTTON_LABELS[decision]}
              </Button>
            )
          })}
          {item.kind === 'issue' && needsYouKindOf(view, false) === 'plan-review' ? (
            <Button variant="outline" size="small" onClick={() => openReviewDialog(item.repoId, item.number)}>
              {REVIEW_PLAN_LABEL}
            </Button>
          ) : null}
        </div>
        {note !== null ? <p className="text-small text-muted-foreground">{note}</p> : null}
        {decisionNote !== null ? <p className="text-small text-muted-foreground">{decisionNote}</p> : null}
      </div>
      {row.blockedOn !== null ? <BlockedOnDetail blockedOn={row.blockedOn} number={ticket.ref.number} /> : null}
      <PhaseList
        view={view}
        details={phaseDetails}
        extraCurrentLine={agentSummary}
        sessions={ticketSessions.byPhase}
        now={now}
        onOpenSession={openSession}
      />
      {sessionIndex.isPending ? <Skeleton className="h-3 w-32" /> : null}
      {sessionIndex.isError ? <ErrorBanner message={PAST_SESSIONS_UNREADABLE} /> : null}
      {ticketSessions.unplaced.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-meta text-muted-foreground">{YOUR_SESSIONS_LABEL}</span>
          {ticketSessions.unplaced.map((link) => (
            <SessionLinkRow key={link.key} link={link} now={now} onOpen={openSession} />
          ))}
        </div>
      ) : null}
      <Button variant="ghost" size="small" className="self-start" onClick={() => void navigate({ to: ROUTE_IDS.settings, search: { section: 'audit', repo: item.repoId, number: item.number } })}>
        <ScrollText aria-hidden="true" className="size-3.5" />
        {WRITE_HISTORY_LABEL}
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
