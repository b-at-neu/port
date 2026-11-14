// The Board card's and row's "held" tag: a short reason inline, the full line and its unblocking action in the tooltip.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { heldDetailCopy, heldTagLabel } from '@/renderer/board/tick'
import type { RowHeld } from '@/types/board'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

export function HeldTag({ held }: { readonly held: RowHeld }) {
  const [first] = held.entries
  const lines = held.entries.map((entry) => heldDetailCopy(entry, held.owner))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-slot="held-tag"
          aria-label={lines.join(' ')}
          className={`max-w-48 shrink-0 truncate rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary ${FOCUS_RING}`}
        >
          {first === undefined ? null : heldTagLabel(first)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
