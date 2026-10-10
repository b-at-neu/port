// A one-line row that expands; an edit's own diff replaces the raw result payload.
import { useState } from 'react'
import { Bot, ChevronRight, FileEdit, FileSearch, FileText, Globe, ListChecks, Search, SquareTerminal, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DiffView } from './diff-view'
import { defaultOpen, toolSummary } from './conversation-model'
import type { GroupedNode, RowView } from './conversation-model'
import { BashBody, LookupBody, TaskBody, TodoBody } from './tool-call-detail'

function ToolIcon({ name, className }: { readonly name: string; readonly className: string }) {
  switch (name) {
    case 'Read':
      return <FileText aria-hidden="true" className={className} />
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return <FileEdit aria-hidden="true" className={className} />
    case 'Bash':
      return <SquareTerminal aria-hidden="true" className={className} />
    case 'Glob':
      return <FileSearch aria-hidden="true" className={className} />
    case 'Grep':
      return <Search aria-hidden="true" className={className} />
    case 'WebFetch':
    case 'WebSearch':
      return <Globe aria-hidden="true" className={className} />
    case 'TodoWrite':
      return <ListChecks aria-hidden="true" className={className} />
    case 'Task':
    case 'Agent':
      return <Bot aria-hidden="true" className={className} />
    default:
      return <Wrench aria-hidden="true" className={className} />
  }
}

export function ToolCallRow({ row, childNodes }: { readonly row: Extract<RowView, { readonly kind: 'tool-call' }>; readonly childNodes: readonly GroupedNode[] }) {
  const [open, setOpen] = useState(() => defaultOpen(row))
  const summary = toolSummary(row, childNodes.length)

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="tool-call-row">
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-small outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <ToolIcon name={row.name} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-foreground-secondary">{row.name === 'Task' || row.name === 'Agent' ? 'Subagent' : row.name}</span>
        {row.detail?.kind === 'task' && row.detail.subagentType !== null ? <span className="shrink-0 rounded bg-muted px-1 font-mono text-meta text-muted-foreground">{row.detail.subagentType}</span> : null}
        <span className="flex-1 truncate font-mono text-meta text-muted-foreground">{row.headline}</span>
        <span className={cn('shrink-0 text-meta', row.result.kind === 'error' ? 'text-danger-pill-foreground' : 'text-muted-foreground')}>{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 py-1 pl-9">
        {row.diff !== null ? (
          <DiffView diff={row.diff} />
        ) : row.detail?.kind === 'bash' ? (
          <BashBody row={row} />
        ) : row.detail?.kind === 'todos' ? (
          <TodoBody row={row} />
        ) : row.detail?.kind === 'task' ? (
          <TaskBody row={row} childNodes={childNodes} />
        ) : row.detail?.kind === 'lookup' ? (
          <LookupBody row={row} />
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-meta font-medium text-muted-foreground">Input</span>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{row.input.text}</pre>
            {row.input.omittedChars > 0 ? <p className="text-meta text-muted-foreground">{row.input.omittedChars} characters not shown</p> : null}
            {row.result.kind !== 'none' ? (
              <div className="flex flex-col gap-1">
                <span className="text-meta font-medium text-muted-foreground">Result</span>
                <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{row.result.payload.text}</pre>
                {row.result.payload.omittedChars > 0 ? <p className="text-meta text-muted-foreground">{row.result.payload.omittedChars} characters not shown</p> : null}
              </div>
            ) : null}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
