// Per-tool bodies for ToolCallRow's expanded content: Bash, TodoWrite, Task, Read/Grep/Glob.
import { CircleDot, Square, SquareCheck } from 'lucide-react'
import { CodeBlock } from './code-block'
import { Markdown } from './markdown'
import type { GroupedNode, RowView } from './conversation-model'
import { ConversationEntry } from './conversation-entry'

export function BashBody({ row }: { readonly row: Extract<RowView, { readonly kind: 'tool-call' }> }) {
  return (
    <div className="flex flex-col gap-2">
      <CodeBlock code={row.detail?.kind === 'bash' ? row.detail.command : row.input.text} language="bash" />
      {row.result.kind !== 'none' ? (
        <div className="flex flex-col gap-1">
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{row.result.payload.text}</pre>
          {row.result.payload.omittedChars > 0 ? <p className="text-meta text-muted-foreground">{row.result.payload.omittedChars} characters not shown</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function TodoIcon({ status }: { readonly status: 'pending' | 'in_progress' | 'completed' }) {
  if (status === 'completed') return <SquareCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-foreground-secondary" />
  if (status === 'in_progress') return <CircleDot aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-working-dot" />
  return <Square aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
}

export function TodoBody({ row }: { readonly row: Extract<RowView, { readonly kind: 'tool-call' }> }) {
  if (row.detail?.kind !== 'todos') return null
  const { detail } = row
  return (
    <ul className="flex flex-col gap-1">
      {detail.items.map((item, index) => (
        <li key={index} className={`flex items-start gap-1.5 text-small ${item.status === 'completed' ? 'text-foreground-secondary' : 'text-foreground'}`}>
          <TodoIcon status={item.status} />
          <span>
            {item.content}
            {item.status === 'in_progress' ? <span className="ml-1 text-meta text-muted-foreground">In progress</span> : null}
          </span>
        </li>
      ))}
      {detail.droppedCount > 0 ? <li className="text-meta text-muted-foreground">{detail.droppedCount} items not shown</li> : null}
    </ul>
  )
}

export function TaskBody({ row, childNodes }: { readonly row: Extract<RowView, { readonly kind: 'tool-call' }>; readonly childNodes: readonly GroupedNode[] }) {
  return (
    <div className="flex flex-col gap-2">
      {childNodes.length > 0 ? (
        <div className="flex flex-col gap-2 border-l border-border pl-3">
          {childNodes.map((child) => (
            <ConversationEntry key={child.entry.uuid} node={child} />
          ))}
        </div>
      ) : null}
      {row.result.kind !== 'none' ? <Markdown source={row.result.payload.text} /> : null}
    </div>
  )
}

export function LookupBody({ row }: { readonly row: Extract<RowView, { readonly kind: 'tool-call' }> }) {
  if (row.result.kind === 'none') return null
  return <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{row.result.payload.text}</pre>
}
