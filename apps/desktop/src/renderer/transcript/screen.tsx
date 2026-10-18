// The Transcript screen — a back button (to History or Search), the title,
// a Following/Paused toggle, Jump to latest, and the read-only conversation.
import { useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ChevronLeft, ChevronsDown } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { StatusPill } from '@/renderer/components/status-pill'
import { ConversationList } from '@/renderer/components/conversation-list'
import { PhaseList } from '@/renderer/components/phase-list'
import { useIpcQuery } from '@/renderer/data/query'
import { agentSummaryOf, stageKeyOf } from '@/renderer/board/row-model'
import type { RepoId } from '@/utils/repos'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { retryTail, toggleFollow, useTranscriptTail } from '@/renderer/transcript/tail-store'
import { subtitleFor, tailBannerCopy, TRUNCATED_NOTE } from '@/renderer/transcript/copy'

function TicketAside({ repoId, number }: { readonly repoId: RepoId; readonly number: number }) {
  const snapshot = useIpcQuery('board:snapshot')

  if (snapshot.status === 'pending') {
    return (
      <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const repoState = snapshot.data?.state.repositories.find((r) => r.repoId === repoId)
  const foundItem = repoState !== undefined && repoState.ok ? repoState.items.find((i) => i.number === number) : undefined

  if (snapshot.status === 'error' || foundItem === undefined) {
    return (
      <div className="w-64 shrink-0 border-l border-border p-4">
        <p className="text-small text-muted-foreground">This ticket is no longer in the pipeline.</p>
      </div>
    )
  }

  const stageKey = stageKeyOf(foundItem.stages, foundItem.stage)
  return (
    <div className="w-64 shrink-0 overflow-y-auto border-l border-border p-4">
      <p className="mb-3 text-small font-medium">
        #{foundItem.number} {foundItem.title}
      </p>
      <PhaseList stageKey={stageKey} kind={foundItem.kind} merged={foundItem.mergedAt !== null} currentDetail={agentSummaryOf(foundItem.agents, foundItem.sessions)} />
    </div>
  )
}

export function TranscriptScreen() {
  const { sessionId } = useParams({ from: ROUTE_IDS.transcript })
  const search = useSearch({ from: ROUTE_IDS.transcript })
  const navigate = useNavigate()
  const tail = useTranscriptTail(sessionId, search.agentId)
  const [jumpSignal, setJumpSignal] = useState(0)

  function back(): void {
    if (search.from === 'search') void navigate({ to: ROUTE_IDS.search, search: {} })
    else if (search.from === 'board' || search.from === 'pipeline') void navigate({ to: ROUTE_IDS.board, search: { item: search.item } })
    else void navigate({ to: ROUTE_IDS.history, search: {} })
  }

  return (
    <Screen
      header={
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
      }
    >
      <div className="flex min-h-0 flex-1">
        {tail.status === 'loading' ? (
          <ScreenBody variant="list">
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </ScreenBody>
        ) : tail.status === 'error' ? (
          <ScreenBody variant="list">
            <ErrorBanner message={tail.message} className="m-4" />
          </ScreenBody>
        ) : tail.status === 'unreachable' ? (
          <ScreenBody variant="list">
            <ErrorBanner message="Could not reach the main process." action={{ label: 'Retry', onClick: retryTail }} className="m-4" />
          </ScreenBody>
        ) : (
          <ScreenBody variant="conversation">
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
          </ScreenBody>
        )}
        {search.item !== null ? <TicketAside repoId={search.item.repoId} number={search.item.number} /> : null}
      </div>
    </Screen>
  )
}
