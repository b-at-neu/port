// `BlockNode[]` to React elements — every node becomes its own element or
// literal text child, never raw HTML injection.
import type { ReactNode } from 'react'
import { parseMarkdown } from '../../../shared/markdown/block'
import type { BlockNode, InlineNode, ListItem, TableAlign } from '../../../shared/markdown/types'
import { cn } from '@/lib/utils'

function renderInline(nodes: readonly InlineNode[]): ReactNode {
  return nodes.map((node, index): ReactNode => {
    switch (node.kind) {
      case 'text':
        return <span key={index}>{node.value}</span>
      case 'code':
        return (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">
            {node.value}
          </code>
        )
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>
      case 'emphasis':
        return <em key={index}>{renderInline(node.children)}</em>
      case 'link':
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer" className="text-primary-text underline-offset-2 hover:underline">
            {node.text}
          </a>
        )
    }
  })
}

function alignStyle(align: TableAlign | undefined): { readonly textAlign: 'left' | 'center' | 'right' } | undefined {
  return align != null ? { textAlign: align } : undefined
}

function ListItemNode({ item }: { readonly item: ListItem }) {
  return (
    <li className={cn('ml-0', item.checked !== null && 'flex list-none items-start gap-1.5')}>
      {item.checked !== null ? <input type="checkbox" checked={item.checked} disabled className="mt-1" /> : null}
      <span>{renderInline(item.inline)}</span>
      {item.children.length > 0 ? <MarkdownBlocks nodes={item.children} /> : null}
    </li>
  )
}

function MarkdownBlocks({ nodes }: { readonly nodes: readonly BlockNode[] }) {
  return (
    <>
      {nodes.map((node, index): ReactNode => {
        switch (node.kind) {
          case 'heading': {
            const Tag = `h${String(node.level)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
            const size = node.level <= 2 ? 'text-title' : 'text-body'
            return (
              <Tag key={index} className={cn(size, 'font-semibold')}>
                {renderInline(node.inline)}
              </Tag>
            )
          }
          case 'paragraph':
            return (
              <p key={index} className="text-body leading-[1.6]">
                {renderInline(node.inline)}
              </p>
            )
          case 'code':
            return (
              <pre key={index} className="overflow-x-auto rounded-lg bg-muted p-2">
                <code className="font-mono text-small" data-language={node.language ?? undefined}>
                  {node.code}
                </code>
              </pre>
            )
          case 'blockquote':
            return (
              <blockquote key={index} className="border-l-2 border-border pl-3 text-muted-foreground">
                <MarkdownBlocks nodes={node.children} />
              </blockquote>
            )
          case 'list': {
            const Tag = node.ordered ? 'ol' : 'ul'
            return (
              <Tag key={index} className={cn('pl-5', node.ordered ? 'list-decimal' : 'list-disc')}>
                {node.items.map((item, itemIndex) => (
                  <ListItemNode key={itemIndex} item={item} />
                ))}
              </Tag>
            )
          }
          case 'table':
            return (
              <table key={index} className="border-collapse border border-border text-body">
                <thead>
                  <tr>
                    {node.header.map((cell, cellIndex) => (
                      <th key={cellIndex} style={alignStyle(node.align[cellIndex])} className="border border-border px-2 py-1 text-left font-semibold">
                        {renderInline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {node.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={alignStyle(node.align[cellIndex])} className="border border-border px-2 py-1">
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          case 'thematic-break':
            return <hr key={index} className="border-border" />
        }
      })}
    </>
  )
}

export interface MarkdownProps {
  readonly source: string
  readonly className?: string
}

// Parses and renders in one call, from a raw markdown string.
export function Markdown({ source, className }: MarkdownProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <MarkdownBlocks nodes={parseMarkdown(source)} />
    </div>
  )
}
