// The Board row's "held on" tag: one pill naming the most specific thing a blocked ticket waits on.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { blockedOnTag } from '@/renderer/board/blocked-on'
import { BLOCKED_DEPENDENCY_HEADING, blockedDependencyLine, blockedTagLabel, blockedTagSummary, blockedTruncatedCopy } from '@/renderer/board/blocked-copy'
import type { BlockedOn } from '@/types/board'
import { cn } from '@/renderer/lib/utils'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

export function BlockedOnTag({ blockedOn }: { readonly blockedOn: BlockedOn }) {
  const tag = blockedOnTag(blockedOn)
  const reason = tag.kind === 'session' || tag.kind === 'comment'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-slot="blocked-on-tag"
          aria-label={blockedTagSummary(tag)}
          className={cn('shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary', FOCUS_RING, reason && 'max-w-48 truncate')}
        >
          {blockedTagLabel(tag)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {tag.kind === 'dependency' ? (
          <>
            <p>{BLOCKED_DEPENDENCY_HEADING}</p>
            <ul>
              {tag.open.map((blocker) => (
                <li key={blocker.number}>{blockedDependencyLine(blocker)}</li>
              ))}
            </ul>
            {tag.total > tag.shown ? <p>{blockedTruncatedCopy(tag.shown, tag.total)}</p> : null}
          </>
        ) : (
          <p>{blockedTagSummary(tag)}</p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
