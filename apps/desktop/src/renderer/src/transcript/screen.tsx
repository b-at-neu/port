// The Transcript screen — a back button (to History or Search), the title,
// a Following/Paused toggle, Jump to latest, and the read-only conversation.
import { useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ChevronLeft, ChevronsDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ScreenHeader } from '../components/screen-header'
import { ErrorBanner } from '../components/error-banner'
import { StatusPill } from '../components/status-pill'
import { ConversationList } from '../components/conversation-list'
import { ROUTE_IDS } from '../router/routes'
import { retryTail, toggleFollow, useTranscriptTail } from './tail-store'
import { subtitleFor, tailBannerCopy, TRUNCATED_NOTE } from './copy'

export function TranscriptScreen() {
  const { sessionId } = useParams({ from: ROUTE_IDS.transcript })
  const search = useSearch({ from: ROUTE_IDS.transcript })
  const navigate = useNavigate()
  const tail = useTranscriptTail(sessionId, search.agentId)
  const [jumpSignal, setJumpSignal] = useState(0)

  function back(): void {
    if (search.from === 'search') void navigate({ to: ROUTE_IDS.search, search: {} })
    else void navigate({ to: ROUTE_IDS.history, search: {} })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <ScreenHeader className="justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="small" onClick={back} aria-label="Back">
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
          <span className="truncate">{search.title !== '' ? search.title : sessionId}</span>
        </div>
        {tail.status === 'ready' ? (
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={toggleFollow} className="outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
              <StatusPill status={tail.following ? 'success' : 'idle'} label={tail.following ? 'Following' : 'Paused'} />
            </button>
            <Button variant="outline" size="small" onClick={() => setJumpSignal((n) => n + 1)}>
              <ChevronsDown aria-hidden="true" className="size-3.5" />
              Jump to latest
            </Button>
          </div>
        ) : null}
      </ScreenHeader>

      {tail.status === 'loading' ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : tail.status === 'error' ? (
        <ErrorBanner message={tail.message} className="m-4" />
      ) : tail.status === 'unreachable' ? (
        <ErrorBanner message="Could not reach the main process." action={{ label: 'Retry', onClick: retryTail }} className="m-4" />
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col gap-2">
          <p className="text-meta text-muted-foreground">{subtitleFor(tail.source, tail.entries.length)}</p>
          {tail.source.malformedLines > 0 ? (
            <p className="text-meta text-muted-foreground">{tail.source.malformedLines} lines in this transcript couldn&apos;t be parsed and aren&apos;t shown.</p>
          ) : null}
          {tail.banner !== null ? (
            <ErrorBanner message={tailBannerCopy(tail.banner.kind, tail.banner.message, tail.banner.path)} action={tail.banner.kind !== 'too-large' ? { label: 'Retry', onClick: retryTail } : undefined} />
          ) : null}
          {tail.truncatedNote ? <p className="text-meta text-muted-foreground">{TRUNCATED_NOTE}</p> : null}
          {tail.entries.length === 0 ? (
            <p className="text-small text-muted-foreground">This transcript has no messages yet.</p>
          ) : (
            <ConversationList entries={tail.entries} baseIndex={0} live={null} focusIndex={search.focusIndex} jumpSignal={jumpSignal} />
          )}
        </div>
      )}
    </div>
  )
}
