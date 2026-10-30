// DESIGN §3 "Your messages" — a stage session's first message, shown as a compact card with its instructions folded away.
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { stageCardTitle } from '@/renderer/components/conversation-model'
import type { RowView } from '@/types/components'

export function StageCard({ row }: { readonly row: Extract<RowView, { readonly kind: 'stage-prompt' }> }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2 text-foreground" data-slot="stage-card">
      <span className="mb-1 block text-meta font-medium text-muted-foreground">Stage</span>
      <p className="text-body font-medium">{stageCardTitle(row)}</p>
      {row.instructions === null ? null : (
        <Collapsible>
          <CollapsibleTrigger className="mt-1 flex h-7 items-center gap-1.5 rounded-md text-left text-small text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-90" />
            Stage instructions
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            {row.source === null ? null : <p className="mb-1 font-mono text-meta break-all text-muted-foreground">From {row.source}</p>}
            <pre className="overflow-x-auto font-sans text-body leading-[1.6] whitespace-pre-wrap">{row.instructions.text}</pre>
            {row.instructions.omittedChars > 0 ? <p className="mt-1 text-meta text-muted-foreground">{row.instructions.omittedChars} characters not shown</p> : null}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
