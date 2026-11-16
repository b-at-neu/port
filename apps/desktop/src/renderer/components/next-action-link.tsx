// The one next-action link a Board row or card carries.
import type { MouseEvent } from 'react'
import type { BoardItemRow } from '@/types/board'
import { nextActionFor } from '@/renderer/board/row-model'
import { openReviewDialog } from '@/renderer/gate/controller'
import { openDecision } from '@/renderer/decision/controller'

export function NextActionLink({ row }: { readonly row: BoardItemRow }) {
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
