// DESIGN's Board `TicketRow` (36px) — #319. The row carries no action strip
// of its own; every operator action lives in the detail pane now
// (`item-pane.tsx`), so this component only needs the row's identity, its
// `PhaseBar`/phase pill, and the one next-action link.
import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import type { BoardItemRow } from '../../../shared/board/types'
import { PHASE_NAMES } from '../lib/phase'
import { autoPlanTagLabel, autoPlanTagTitle } from '../board/copy'
import { nextActionFor, pillStatusFor } from '../board/row-model'
import { openReviewDialog } from '../gate/controller'
import { openDecision } from '../decision/controller'
import { PhaseBar } from './phase-bar'
import { StatusPill } from './status-pill'

export interface TicketRowProps {
  readonly row: BoardItemRow
  readonly selected: boolean
  readonly onSelect: () => void
}

function phaseLabel(row: BoardItemRow): string {
  return row.stageLabel !== null ? (PHASE_NAMES[row.stageLabel.key] ?? row.stageLabel.key) : 'Unstaged'
}

function NextActionLink({ row, onSelect }: { readonly row: BoardItemRow; readonly onSelect: () => void }) {
  const action = nextActionFor(row)
  if (action === null) return null

  function handleClick(event: MouseEvent): void {
    event.stopPropagation()
    if (action === null) return
    switch (action.kind) {
      case 'review-plan':
        openReviewDialog(row.item.repoId, row.item.number)
        return
      case 'answer-question':
        onSelect()
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
    <button type="button" onClick={handleClick} className="shrink-0 text-small text-primary-text hover:underline">
      {action.label}
    </button>
  )
}

export function TicketRow({ row, selected, onSelect }: TicketRowProps) {
  const { item } = row

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') onSelect()
  }

  return (
    <div
      data-slot="ticket-row"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn('flex h-9 items-center gap-2 px-4 text-small outline-none', selected && 'bg-selection ring-2 ring-ring ring-inset')}
    >
      <span className="w-10 shrink-0 font-mono tabular-nums text-muted-foreground">#{item.number}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
      <span className="shrink-0 text-meta text-muted-foreground">{item.repo}</span>
      {item.autoPlan ? (
        <span title={autoPlanTagTitle()} className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-meta text-foreground-secondary">
          {autoPlanTagLabel()}
        </span>
      ) : null}
      <PhaseBar stageKey={row.stageLabel?.key ?? null} kind={item.kind} merged={item.mergedAt !== null} className="shrink-0" />
      <StatusPill status={pillStatusFor(row)} label={phaseLabel(row)} className="shrink-0" />
      <NextActionLink row={row} onSelect={onSelect} />
    </div>
  )
}
