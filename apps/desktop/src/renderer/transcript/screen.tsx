import { useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ChevronLeft, ChevronsDown, FileText } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Page } from '@/renderer/components/page'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { StatusPill } from '@/renderer/components/status-pill'
import { ConversationList } from '@/renderer/components/conversation-list'
import { PhaseList } from '@/renderer/components/phase-list'
import { useIpcQuery } from '@/renderer/data/query'
import { agentSummaryOf } from '@/renderer/board/row-model'
import { ticketViewOfItem } from '@/utils/pipeline/stages'
import type { RepoId } from '@/utils/repos'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { useTranscript } from '@/renderer/data/transcript'
import { backTarget, ticketOf, transcriptPageOf } from '@/renderer/transcript/model'
import {
  BACK_LABEL,
  FOLLOWING,
  JUMP_TO_LATEST,
  malformedLinesNote,
  NO_MESSAGES_YET,
  PAUSED,
  RETRY,
  subtitleFor,
  tailBannerCopy,
  tailBannerKindFor,
  TICKET_GONE,
  transcriptErrorCopy,
  TRUNCATED_NOTE,
} from '@/renderer/transcript/copy'

function TicketAside({ repoId, number }: { readonly repoId: RepoId; readonly number: number }) {
  const snapshot = useIpcQuery('board.snapshot')

  if (snapshot.status === 'pending') {
    return (
      <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const ticket = snapshot.status === 'error' ? null : ticketOf(snapshot.data, repoId, number)

  if (ticket === null) {
    return (
      <div className="w-64 shrink-0 border-l border-border p-4">
        <p className="text-small text-muted-foreground">{TICKET_GONE}</p>
      </div>
    )
  }

  return (
    <div className="w-64 shrink-0 overflow-y-auto border-l border-border p-4">
      <p className="mb-3 text-small font-medium">
        #{ticket.number} {ticket.title}
      </p>
      <PhaseList view={ticketViewOfItem(ticket)} details={{}} extraCurrentLine={agentSummaryOf(ticket.agents, ticket.sessions)} />
    </div>
  )
}

export function TranscriptScreen() {
  const { sessionId } = useParams({ from: ROUTE_IDS.transcript })
  const search = useSearch({ from: ROUTE_IDS.transcript })
  const navigate = useNavigate()
  const { view: tail, toggleFollow, retry } = useTranscript({ kind: 'file', sessionId, agentId: search.agentId })
  const [jumpSignal, setJumpSignal] = useState(0)
  const page = transcriptPageOf(tail)

  function back(): void {
    const target = backTarget(search.from, search.item)
    if (target.to === 'search') void navigate({ to: ROUTE_IDS.search, search: {} })
    else if (target.to === 'board') void navigate({ to: ROUTE_IDS.board, search: { item: target.item } })
    else void navigate({ to: ROUTE_IDS.history, search: {} })
  }

  return (
    <Page
      variant="conversation"
      header={
        <ScreenHeader className="justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="small" onClick={back} aria-label={BACK_LABEL}>
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <span className="truncate">{search.title !== '' ? search.title : sessionId}</span>
          </div>
          {tail.status === 'ready' ? (
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={toggleFollow} className="outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
                <StatusPill status={tail.following ? 'success' : 'idle'} label={tail.following ? FOLLOWING : PAUSED} />
              </button>
              <Button variant="outline" size="small" onClick={() => setJumpSignal((n) => n + 1)}>
                <ChevronsDown aria-hidden="true" className="size-3.5" />
                {JUMP_TO_LATEST}
              </Button>
            </div>
          ) : null}
        </ScreenHeader>
      }
      aside={search.item !== null ? <TicketAside repoId={search.item.repoId} number={search.item.number} /> : undefined}
      lead={
        tail.status === 'ready' ? (
          <>
            <p className="text-meta text-muted-foreground">{subtitleFor(tail.source, tail.entries.length)}</p>
            {tail.source.malformedLines > 0 ? <p className="text-meta text-muted-foreground">{malformedLinesNote(tail.source.malformedLines)}</p> : null}
            {tail.failure !== null ? (
              <ErrorBanner message={tailBannerCopy(tailBannerKindFor(tail.failure.kind), tail.failure.message, tail.failure.path)} action={tail.failure.kind !== 'too-large' ? { label: RETRY, onClick: retry } : undefined} />
            ) : null}
            {tail.truncatedNote ? <p className="text-meta text-muted-foreground">{TRUNCATED_NOTE}</p> : null}
          </>
        ) : undefined
      }
      state={page.state}
      loading={
        <>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </>
      }
      errorMessage={page.error === null ? '' : transcriptErrorCopy(page.error)}
      onRetry={retry}
      empty={<EmptyState icon={FileText} message={NO_MESSAGES_YET} />}
    >
      {tail.status === 'ready' ? <ConversationList entries={tail.entries} baseIndex={0} live={null} focusIndex={search.focusIndex} jumpSignal={jumpSignal} /> : null}
    </Page>
  )
}
