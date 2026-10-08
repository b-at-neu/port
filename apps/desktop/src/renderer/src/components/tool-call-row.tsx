// A one-line row that expands; an edit's own diff replaces the raw result payload.
import { useState } from 'react'
import { ChevronRight, FileEdit, FileSearch, FileText, Globe, Search, SquareTerminal, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DiffView } from './diff-view'
import type { RowView, ToolResultView } from './conversation-model'

const TOOL_ICONS: Readonly<Record<string, typeof Wrench>> = {
  Read: FileText,
  Write: FileEdit,
  Edit: FileEdit,
  MultiEdit: FileEdit,
  NotebookEdit: FileEdit,
  Bash: SquareTerminal,
  Glob: FileSearch,
  Grep: Search,
  WebFetch: Globe,
  WebSearch: Globe,
}

function iconFor(name: string): typeof Wrench {
  return TOOL_ICONS[name] ?? Wrench
}

function resultLabel(result: ToolResultView): string {
  if (result.kind === 'none') return 'no result'
  if (result.kind === 'error') return 'error'
  return 'ok'
}

export function ToolCallRow({ row }: { readonly row: Extract<RowView, { readonly kind: 'tool-call' }> }) {
  const [open, setOpen] = useState(false)
  const Icon = iconFor(row.name)

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="tool-call-row">
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-small outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-foreground-secondary">{row.name}</span>
        <span className="flex-1 truncate font-mono text-meta text-muted-foreground">{row.headline}</span>
        <span className={cn('shrink-0 text-meta', row.result.kind === 'error' ? 'text-danger-pill-foreground' : 'text-muted-foreground')}>{resultLabel(row.result)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 py-1 pl-9">
        <div className="flex flex-col gap-1">
          <span className="text-meta font-medium text-muted-foreground">Input</span>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{row.input.text}</pre>
          {row.input.omittedChars > 0 ? <p className="text-meta text-muted-foreground">{row.input.omittedChars} characters not shown</p> : null}
        </div>
        {row.diff !== null ? (
          <DiffView diff={row.diff} />
        ) : row.result.kind !== 'none' ? (
          <div className="flex flex-col gap-1">
            <span className="text-meta font-medium text-muted-foreground">Result</span>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{row.result.payload.text}</pre>
            {row.result.payload.omittedChars > 0 ? <p className="text-meta text-muted-foreground">{row.result.payload.omittedChars} characters not shown</p> : null}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
