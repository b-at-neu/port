// One file's hunks, styled by the diff-added/diff-removed tokens, never a raw colour.
import { cn } from '@/lib/utils'
import type { DiffHunk, FileDiff } from '../../../shared/sessions/transcript'
import { diffSummary, hunkHeader } from './conversation-model'

function HunkView({ hunk }: { readonly hunk: DiffHunk }) {
  return (
    <div className="flex flex-col">
      <div className="px-3 py-1 font-mono text-meta text-muted-foreground">{hunkHeader(hunk)}</div>
      <pre className="overflow-x-auto px-3 pb-2 font-mono text-meta leading-[1.5]">
        {hunk.lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              'whitespace-pre-wrap',
              line.sign === 'add' && 'bg-diff-added text-diff-added-foreground',
              line.sign === 'del' && 'bg-diff-removed text-diff-removed-foreground',
            )}
          >
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

export function DiffView({ diff }: { readonly diff: FileDiff }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-muted px-3 py-1.5 font-mono text-meta text-foreground-secondary">{diffSummary(diff)}</div>
      {diff.hunks.map((hunk, index) => (
        <HunkView key={index} hunk={hunk} />
      ))}
    </div>
  )
}
