// The item pane's "Blocked on" block: every available source, not only the one the row tag shows.
import { BlockerAnswer } from '@/renderer/board/blocker-answer'
import { BLOCKED_AGENT_SAYS, BLOCKED_FALLBACK_COPY, BLOCKED_FROM_TICKET, BLOCKED_OPEN_COMMENT, BLOCKED_SECTION_HEADING, blockedDependencyLine, blockedTruncatedCopy, blockedUnreadableCopy } from '@/renderer/board/blocked-copy'
import type { BlockedOn } from '@/types/board'

interface BlockedOnDetailProps {
  readonly blockedOn: BlockedOn
  readonly number: number
}

export function BlockedOnDetail({ blockedOn, number }: BlockedOnDetailProps) {
  const { dependencies, session, comment } = blockedOn
  const open = dependencies?.ok === true ? dependencies.open : []
  const hasReason = open.length > 0 || session !== null || comment !== null || dependencies?.ok === false
  return (
    <div data-slot="blocked-on-detail" className="flex flex-col gap-2">
      <span className="text-meta text-muted-foreground">{BLOCKED_SECTION_HEADING}</span>
      {open.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-small">
          {open.map((blocker) => (
            <li key={blocker.number}>
              <a href={blocker.url} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
                {blockedDependencyLine(blocker)}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {dependencies?.ok === true && dependencies.total > dependencies.shown ? <p className="text-meta text-muted-foreground">{blockedTruncatedCopy(dependencies.shown, dependencies.total)}</p> : null}
      {dependencies?.ok === false ? <p className="text-small text-muted-foreground">{blockedUnreadableCopy(dependencies.reason)}</p> : null}
      {session !== null ? (
        <div className="flex flex-col gap-1">
          <span className="text-small text-foreground">{BLOCKED_AGENT_SAYS}</span>
          <div className="rounded-md bg-muted px-3 py-2 font-mono text-meta text-muted-foreground">{session.text}</div>
          <BlockerAnswer sessionKey={session.sessionKey} number={number} />
        </div>
      ) : null}
      {comment !== null ? (
        <div className="flex flex-col gap-1">
          <span className="text-small text-foreground">{BLOCKED_FROM_TICKET}</span>
          <p className="text-small text-muted-foreground">{comment.text}</p>
          <a href={comment.url} target="_blank" rel="noreferrer" className="self-start text-small text-primary-text hover:underline">
            {BLOCKED_OPEN_COMMENT}
          </a>
        </div>
      ) : null}
      {hasReason ? null : <p className="text-small text-muted-foreground">{BLOCKED_FALLBACK_COPY}</p>}
    </div>
  )
}
