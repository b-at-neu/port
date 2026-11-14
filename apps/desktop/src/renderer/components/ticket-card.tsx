// The Board kanban's TicketCard — identity, phase pill and the one next action, with a narrow edge in the card's own phase tone.
import { useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/renderer/lib/utils'
import type { BoardItemRow } from '@/types/board'
import { actionButtonLabel, actionPendingLabel, actionResultCopy, autoPlanTagTitle, dispatchedTagTitle, noTicketTagLabel, noTicketTagTitle, ungatedTagLabel, ungatedTagTitle } from '@/renderer/board/copy'
import { itemActionState, runItemAction, subscribeItemActions } from '@/renderer/board/actions'
import { isDispatchedRow, phaseLabelFor, phaseToneFor } from '@/renderer/board/row-model'
import { prSuffixOf } from '@/utils/tickets/ticket'
import { BlockedOnTag } from '@/renderer/components/blocked-on-tag'
import { NextActionLink } from '@/renderer/components/next-action-link'
import { PhasePill } from '@/renderer/components/phase-pill'
import { PHASE_EDGE_CLASS } from '@/renderer/components/phase-classes'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { useListSelection } from '@/renderer/shell/list-selection'

interface TicketCardProps {
  readonly row: BoardItemRow
  readonly ungated: boolean
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
}

function IconTag({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={label} className="shrink-0 text-muted-foreground">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function AddGateAction({ row }: { readonly row: BoardItemRow }) {
  const { item } = row
  const state = useSyncExternalStore(subscribeItemActions, () => itemActionState(item.repoId, item.number))
  const pending = state?.kind === 'pending' && state.action === 'gate'

  async function handleClick(): Promise<void> {
    await runItemAction({ repoId: item.repoId, kind: item.kind, number: item.number, action: 'gate', expectedStage: row.stageLabel?.key ?? null })
    const result = itemActionState(item.repoId, item.number)
    if (result?.kind === 'result' && !result.result.ok) {
      const availability = row.actions.gate
      toast(actionResultCopy({ action: 'gate', number: row.ticket.ref.number, plan: availability.available ? availability.plan : null, currentStageName: row.stageLabel?.name ?? null, result: result.result, now: new Date() }))
    }
  }

  return (
    <Button
      variant="ghost"
      size="small"
      disabled={pending}
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onClick={() => void handleClick()}
      className="shrink-0 text-primary-text"
    >
      {pending ? actionPendingLabel('gate') : actionButtonLabel('gate')}
    </Button>
  )
}

export function TicketCard({ row, ungated, rowProps }: TicketCardProps) {
  const ref = row.ticket.ref
  const prSuffix = prSuffixOf(ref)
  const tone = phaseToneFor(row)

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') rowProps.onFocus()
  }

  return (
    <div
      data-slot="ticket-card"
      role="button"
      {...rowProps}
      onKeyDown={handleKeyDown}
      className={cn('flex flex-col gap-1 rounded-lg border border-border bg-card p-2 text-body hover:bg-accent', PHASE_EDGE_CLASS[tone.palette], rowProps.className)}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {ref.kind === 'issue' ? '#' : 'PR#'}
          {ref.number}
        </span>
        {prSuffix !== null ? <span className="shrink-0 tabular-nums text-muted-foreground">{prSuffix}</span> : null}
        {ref.kind === 'unlinked-pr' ? (
          <span title={noTicketTagTitle()} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary">
            {noTicketTagLabel()}
          </span>
        ) : null}
        <span className="flex-1" />
        {row.item.autoPlan ? (
          <IconTag label={autoPlanTagTitle()}>
            <Sparkles aria-hidden="true" className="size-4" />
          </IconTag>
        ) : null}
        {isDispatchedRow(row) ? (
          <IconTag label={dispatchedTagTitle()}>
            <Send aria-hidden="true" className="size-4" />
          </IconTag>
        ) : null}
      </div>
      <div title={ref.title} className="line-clamp-2 text-foreground">
        {ref.title}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PhasePill tone={tone} label={phaseLabelFor(row)} className="shrink-0" />
        {ungated ? (
          <span title={ungatedTagTitle()} className="shrink-0 rounded-full bg-attention-pill px-1.5 py-0.5 text-meta text-attention-pill-foreground">
            {ungatedTagLabel()}
          </span>
        ) : null}
        {row.blockedOn !== null ? <BlockedOnTag blockedOn={row.blockedOn} /> : null}
        <span className="flex-1" />
        {ungated ? <AddGateAction row={row} /> : <NextActionLink row={row} />}
      </div>
    </div>
  )
}
