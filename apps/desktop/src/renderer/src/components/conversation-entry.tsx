// DESIGN §3 Conversation — one shared row per `TranscriptEntry`, reused by
// the live session view and the on-disk transcript view.
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Markdown } from './markdown'
import { ToolCallRow } from './tool-call-row'
import { buildRow, PROMPT_CLAMP_LINES } from './conversation-model'
import type { GroupedNode, RowView } from './conversation-model'

function PromptText({ row }: { readonly row: Extract<RowView, { readonly kind: 'user-text' }> }) {
  const [expanded, setExpanded] = useState(false)
  const lines = row.text.text.split('\n')
  const clamped = lines.length > PROMPT_CLAMP_LINES
  const shown = !expanded && clamped ? lines.slice(0, PROMPT_CLAMP_LINES).join('\n') : row.text.text

  return (
    <div className="rounded-lg bg-muted px-3 py-2 text-foreground">
      <span className="mb-1 block text-meta font-medium text-muted-foreground">Prompt</span>
      <pre className="overflow-x-auto font-sans text-body leading-[1.6] whitespace-pre-wrap">{shown}</pre>
      {clamped && !expanded ? (
        <button type="button" onClick={() => setExpanded(true)} className="mt-1 text-meta text-primary-text hover:underline">
          Show all
        </button>
      ) : null}
      {row.text.omittedChars > 0 ? <p className="mt-1 text-meta text-muted-foreground">{row.text.omittedChars} characters not shown</p> : null}
    </div>
  )
}

function ThinkingRow({ row }: { readonly row: Extract<RowView, { readonly kind: 'thinking' }> }) {
  return (
    <Collapsible data-slot="thinking-row">
      <CollapsibleTrigger className="flex h-7 items-center gap-1.5 rounded-md px-1 text-left text-small text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon />
        Thinking · {row.wordCount} words
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 py-1 text-small text-muted-foreground">
        <pre className="overflow-x-auto font-sans whitespace-pre-wrap">{row.text.text}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ChevronRightIcon() {
  return <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-90" />
}

function EntryBody({ node }: { readonly node: GroupedNode }) {
  const row = buildRow(node.entry)
  switch (row.kind) {
    case 'user-text':
      return <PromptText row={row} />
    case 'assistant-text':
      return (
        <div>
          <span className="mb-1 block text-meta font-medium text-muted-foreground">Claude</span>
          <Markdown source={row.text.text} />
        </div>
      )
    case 'thinking':
      return <ThinkingRow row={row} />
    case 'tool-call':
      return <ToolCallRow row={row} childNodes={node.children} />
    case 'meta':
      return <div className="text-meta text-muted-foreground">System · {row.label}</div>
  }
}

export function ConversationEntry({ node }: { readonly node: GroupedNode }) {
  if (!node.orphanSubagent) return <EntryBody node={node} />
  return (
    <div>
      <p className="mb-1 text-meta text-muted-foreground">Subagent · parent call not shown</p>
      <EntryBody node={node} />
    </div>
  )
}
