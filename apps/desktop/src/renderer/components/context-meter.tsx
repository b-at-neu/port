// DESIGN §4 ContextMeter — a label, a 56×4px track and the percentage; token counts stay in the tooltip.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { CONTEXT_METER_LABEL, contextMeterLabel } from '@/renderer/session/rail-copy'
import { contextPercent, type SessionUsage } from '@/utils/hosting/usage'

export function ContextMeter({ usage }: { readonly usage: SessionUsage | null }) {
  const percent = contextPercent(usage)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-label="Context used"
          data-slot="context-meter"
          className="flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="text-meta text-muted-foreground">{CONTEXT_METER_LABEL}</span>
          <span className="h-1 w-14overflow-hidden rounded-full bg-accent">
            {percent !== null ? <span className="block h-full rounded-full bg-primary-text" style={{ width: `${String(percent)}%` }} /> : null}
          </span>
          <span className="text-meta text-muted-foreground tabular-nums">{percent !== null ? `${String(percent)}%` : '—'}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{contextMeterLabel(usage)}</TooltipContent>
    </Tooltip>
  )
}
