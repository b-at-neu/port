// A highlighted code block — plain React elements and text nodes only, no raw-HTML injection.
import { highlightTokens } from './highlight'
import { cn } from '@/lib/utils'

const ROLE_CLASS = {
  keyword: 'text-syntax-keyword',
  string: 'text-syntax-string',
  comment: 'text-syntax-comment',
  constant: 'text-syntax-constant',
  function: 'text-syntax-function',
  'diff-add': 'text-syntax-string',
  'diff-del': 'text-syntax-keyword',
} as const

export interface CodeBlockProps {
  readonly code: string
  readonly language: string | null
  readonly className?: string
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const runs = highlightTokens(code, language)
  return (
    <pre className={cn('overflow-x-auto rounded-lg bg-muted p-2', className)}>
      <code className="font-mono text-small text-foreground">
        {runs.map((run, index) => (run.role === null ? <span key={index}>{run.text}</span> : <span key={index} className={ROLE_CLASS[run.role]}>{run.text}</span>))}
      </code>
    </pre>
  )
}
