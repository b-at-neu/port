// The Board's TicketRow (36px) — identity, PhaseBar/phase pill, and the
// one next-action link; every operator action lives in the detail pane.
import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '@/renderer/lib/utils'
import type { BoardItemRow } from '@/types/board'
import { autoPlanTagLabel, autoPlanTagTitle, dispatchedTagLabel, dispatchedTagTitle, noTicketTagLabel, noTicketTagTitle, operatorJoinedTagLabel, operatorJoinedTagTitle } from '@/renderer/board/copy'
import { prSuffixOf } from '@/utils/tickets/ticket'
import { isDispatchedRow, nextActionFor, phaseLabelFor, phaseToneFor } from '@/renderer/board/row-model'
import { openReviewDialog } from '@/renderer/gate/controller'
import { openDecision } from '@/renderer/decision/controller'
import { PhaseBar } from '@/renderer/components/phase-bar'
import { PhasePill } from '@/renderer/components/phase-pill'
import type { useListSelection } from '@/renderer/shell/list-selection'

interface TicketRowProps {
  readonly row: BoardItemRow
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
  /** `true` when an operator has typed into one of this item's stage sessions — renders an `Operator joined` tag after the phase pill. */
  readonly operatorJoined?: boolean
}

function NextActionLink({ row }: { readonly row: BoardItemRow }) {
  const action = nextActionFor(row)
  if (action === null) return null

  function handleClick(event: MouseEvent): void {
    event.stopPropagation()
    if (action === null) return
    switch (action.kind) {
      case 'review-plan':
        openReviewDialog(row.item.repoId, row.item.number)
        return
      case 'open-pr':
        window.open(action.url, '_blank')
        return
      case 'decision': {
        const availability = row.decisions[action.decision]
        if (!availability.available) return
        openDecision({ repoId: row.item.repoId, number: row.item.number, decision: action.decision, expectedStage: row.stageLabel?.key ?? null, context: availability.context })
      }
    }
  }

  return (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onClick={handleClick}
      className="shrink-0 text-small text-primary-text hover:underline"
    >
      {action.label}
    </button>
  )
}

export function TicketRow({ row, rowProps, operatorJoined = false }: TicketRowProps) {
  const { item } = row
  const ref = row.ticket.ref
  const prSuffix = prSuffixOf(ref)

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') rowProps.onFocus()
  }

  return (
    <div data-slot="ticket-row" role="button" {...rowProps} onKeyDown={handleKeyDown} className={cn('flex h-9 items-center gap-2 px-4 text-body', rowProps.className)}>
      <span className="min-w-10 shrink-0 font-mono tabular-nums text-muted-foreground">
        {ref.kind === 'issue' ? '#' : 'PR#'}
        {ref.number}
      </span>
      <span className="min-w-0 truncate text-foreground">{ref.title}</span>
      {prSuffix !== null ? <span className="shrink-0 tabular-nums text-muted-foreground">{prSuffix}</span> : null}
      <span className="flex-1" />
      {ref.kind === 'unlinked-pr' ? (
        <span title={noTicketTagTitle()} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary">
          {noTicketTagLabel()}
        </span>
      ) : null}
      <span className="shrink-0 text-meta text-muted-foreground">{item.repo}</span>
      {item.autoPlan ? (
        <span title={autoPlanTagTitle()} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary">
          {autoPlanTagLabel()}
        </span>
      ) : null}
      <PhaseBar stageKey={row.stageLabel?.key ?? null} kind={item.kind} merged={item.mergedAt !== null} className="shrink-0" />
      <PhasePill tone={phaseToneFor(row)} label={phaseLabelFor(row)} className="shrink-0" />
      {isDispatchedRow(row) ? (
        <span title={dispatchedTagTitle()} aria-label={dispatchedTagTitle()} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary">
          {dispatchedTagLabel()}
        </span>
      ) : null}
      {operatorJoined ? (
        <span title={operatorJoinedTagTitle()} aria-label={operatorJoinedTagTitle()} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary">
          {operatorJoinedTagLabel()}
        </span>
      ) : null}
      <NextActionLink row={row} />
    </div>
  )
}
