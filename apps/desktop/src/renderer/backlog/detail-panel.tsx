import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, Ban, CircleCheck, CircleDot, Clock, Pencil, Play, User, UserX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DetailPane } from '@/renderer/components/detail-pane'
import { PaneCloseButton } from '@/renderer/components/pane-close-button'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { OPEN_TICKET_LABEL } from '@/renderer/board/copy'
import { Markdown } from '@/renderer/components/markdown'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useIpcQuery } from '@/renderer/data/query'
import { exactTime, formatAgoSince } from '@/renderer/lib/time'
import { assigneeView, epicSummaryView, linkListView } from '@/renderer/backlog/detail'
import {
  BACKLOG_DETAIL_CLOSE,
  BACKLOG_DETAIL_NONE,
  BACKLOG_DETAIL_NO_BODY,
  BACKLOG_DETAIL_RETRY,
  BACKLOG_DETAIL_UNASSIGNED,
  BACKLOG_DETAIL_UNREADABLE,
  BACKLOG_EPIC_SUBISSUES_UNREADABLE,
  BACKLOG_EPIC_TAG,
  BACKLOG_META_ASSIGNEE,
  BACKLOG_META_AUTHOR,
  BACKLOG_META_BLOCKED_BY,
  BACKLOG_META_BLOCKS,
  BACKLOG_META_CAN_START,
  BACKLOG_META_DONE,
  BACKLOG_META_IN_PROGRESS,
  BACKLOG_META_OPENED,
  BACKLOG_META_UPDATED,
  backlogDetailFailureCopy,
  backlogDetailInvokeErrorCopy,
  backlogDetailMoreCopy,
  backlogDetailRegionAria,
  backlogEpicDoneCopy,
  backlogEpicInProgressCopy,
  backlogEpicTruncatedCopy,
} from '@/renderer/backlog/copy'
import type { BacklogDetail, BacklogEpicGroup, BacklogLinkListView, BacklogRowView } from '@/types/backlog'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

function useBacklogDetail(row: BacklogRowView) {
  return useIpcQuery('backlog.detail', { repoId: row.repoId, number: row.number })
}

type DetailQuery = ReturnType<typeof useBacklogDetail>

function MetaList({ children }: { readonly children: ReactNode }) {
  return (
    <div data-slot="backlog-detail-meta" className="flex flex-col gap-1.5 text-meta text-muted-foreground">
      {children}
    </div>
  )
}

function MetaItem({ icon: Icon, name, field, tooltip, children }: { readonly icon: LucideIcon; readonly name: string; readonly field: string; readonly tooltip?: string; readonly children: ReactNode }) {
  return (
    <span data-slot="backlog-meta-item" data-field={field} className="inline-flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={name} className={`inline-flex rounded ${FOCUS_RING}`}>
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip ?? name}</TooltipContent>
      </Tooltip>
      {children}
    </span>
  )
}

function LinkItem({ number, title, url, closed }: { readonly number: number; readonly title: string; readonly url: string; readonly closed?: boolean }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" title={title} className={`rounded text-foreground hover:underline ${FOCUS_RING} ${closed === true ? 'line-through' : ''}`}>
      #{number}
      {closed === true ? <span className="sr-only"> (closed)</span> : null}
    </a>
  )
}

function LinkValues({
  items,
}: {
  readonly items: readonly {
    readonly number: number
    readonly title: string
    readonly url: string
    readonly closed?: boolean
  }[]
}) {
  return (
    <span>
      {items.map((item, index) => (
        <Fragment key={item.number}>
          {index > 0 ? ', ' : null}
          <LinkItem {...item} />
        </Fragment>
      ))}
    </span>
  )
}

function UnreadableValue({ text, reason }: { readonly text: string; readonly reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={`rounded ${FOCUS_RING}`}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

function LinkListValue({ view }: { readonly view: BacklogLinkListView }) {
  if (view.kind === 'failed') return <UnreadableValue text={BACKLOG_DETAIL_UNREADABLE} reason={view.reason} />
  if (view.kind === 'none') return <span>{BACKLOG_DETAIL_NONE}</span>
  return (
    <span>
      <LinkValues items={view.items} />
      {view.more > 0 ? ` ${backlogDetailMoreCopy(view.more)}` : null}
    </span>
  )
}

function BodySkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

function DetailBody({ body }: { readonly body: string }) {
  if (body.trim() === '') return <p className="text-small text-muted-foreground">{BACKLOG_DETAIL_NO_BODY}</p>
  return <Markdown source={body} />
}

function DetailError({ query, number }: { readonly query: DetailQuery; readonly number: number }) {
  const message = query.data?.ok === false ? backlogDetailFailureCopy(number, query.data.kind, query.data.message) : backlogDetailInvokeErrorCopy(number)
  return <ErrorBanner message={message} action={{ label: BACKLOG_DETAIL_RETRY, onClick: () => void query.refetch() }} />
}

function failed(query: DetailQuery): boolean {
  return query.isError || query.data?.ok === false
}

function TicketMetaItems({ detail, now }: { readonly detail: BacklogDetail; readonly now: Date }) {
  const assignee = assigneeView(detail.assignees)
  return (
    <>
      <MetaItem icon={Ban} name={BACKLOG_META_BLOCKED_BY} field="blocked-by">
        <LinkListValue view={linkListView(detail.blockedBy)} />
      </MetaItem>
      <MetaItem icon={ArrowRight} name={BACKLOG_META_BLOCKS} field="blocks">
        <LinkListValue view={linkListView(detail.blocking)} />
      </MetaItem>
      {detail.author !== null ? (
        <MetaItem icon={Pencil} name={BACKLOG_META_AUTHOR} field="author">
          <span>{detail.author}</span>
        </MetaItem>
      ) : null}
      <MetaItem icon={Clock} name={BACKLOG_META_UPDATED} field="updated" tooltip={`${BACKLOG_META_UPDATED} · ${exactTime(detail.updatedAt)}`}>
        <span>{formatAgoSince(detail.updatedAt, now)}</span>
      </MetaItem>
      <MetaItem icon={assignee.kind === 'unassigned' ? UserX : User} name={BACKLOG_META_ASSIGNEE} field="assignee">
        <span>{assignee.kind === 'unassigned' ? BACKLOG_DETAIL_UNASSIGNED : assignee.text}</span>
      </MetaItem>
    </>
  )
}

function MetaSkeleton() {
  return (
    <>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
    </>
  )
}

function EpicSummaryItems({ group }: { readonly group: BacklogEpicGroup }) {
  const view = epicSummaryView(group.summary, group.epic.url)
  if (!view.ok) {
    return (
      <MetaItem icon={CircleDot} name={BACKLOG_EPIC_SUBISSUES_UNREADABLE} field="subissues">
        <UnreadableValue text={BACKLOG_EPIC_SUBISSUES_UNREADABLE} reason={view.reason} />
      </MetaItem>
    )
  }
  return (
    <>
      <MetaItem icon={CircleCheck} name={BACKLOG_META_DONE} field="done" tooltip={view.truncated === null ? BACKLOG_META_DONE : backlogEpicTruncatedCopy(view.truncated.shown, view.truncated.total)}>
        <span>{backlogEpicDoneCopy(view.done, view.total)}</span>
      </MetaItem>
      <MetaItem icon={CircleDot} name={BACKLOG_META_IN_PROGRESS} field="in-progress">
        <span>{backlogEpicInProgressCopy(view.inProgress)}</span>
      </MetaItem>
      <MetaItem icon={Play} name={BACKLOG_META_CAN_START} field="can-start">
        {view.canStart.length === 0 ? <span>{BACKLOG_DETAIL_NONE}</span> : <LinkValues items={view.canStart.map((child) => ({ ...child, closed: false }))} />}
      </MetaItem>
    </>
  )
}

function EpicDetailItems({ query, now }: { readonly query: DetailQuery; readonly now: Date }) {
  const response = query.data
  if (response?.ok !== true) return failed(query) ? null : <Skeleton className="h-4 w-24" />
  const { author, createdAt } = response.detail
  return (
    <>
      {author !== null ? (
        <MetaItem icon={Pencil} name={BACKLOG_META_AUTHOR} field="author">
          <span>{author}</span>
        </MetaItem>
      ) : null}
      {createdAt !== null ? (
        <MetaItem icon={Clock} name={BACKLOG_META_OPENED} field="age" tooltip={`${BACKLOG_META_OPENED} · ${exactTime(createdAt)}`}>
          <span>{formatAgoSince(createdAt, now)}</span>
        </MetaItem>
      ) : null}
    </>
  )
}

interface BacklogDetailPaneProps {
  readonly row: BacklogRowView
  readonly epic: BacklogEpicGroup | null
  readonly now: Date
  readonly onClose: () => void
}

export function BacklogDetailPane({ row, epic, now, onClose }: BacklogDetailPaneProps) {
  const query = useBacklogDetail(row)
  const response = query.data
  const isFailed = failed(query)
  return (
    <DetailPane onClose={onClose} data-slot="backlog-detail" data-ticket={row.number} aria-label={backlogDetailRegionAria(row.number)}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-title font-semibold text-foreground">{row.title}</h2>
          <PaneCloseButton label={BACKLOG_DETAIL_CLOSE} onClick={onClose} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
          <span>#{row.number}</span>
          <span>{row.repo}</span>
          {epic !== null ? <span>{BACKLOG_EPIC_TAG}</span> : null}
        </div>
        <div className="flex items-center gap-3 text-small">
          <a href={row.url} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
            {OPEN_TICKET_LABEL}
          </a>
        </div>
      </div>
      {epic !== null ? (
        <MetaList>
          <EpicSummaryItems group={epic} />
          <EpicDetailItems query={query} now={now} />
        </MetaList>
      ) : isFailed ? null : (
        <MetaList>{response?.ok === true ? <TicketMetaItems detail={response.detail} now={now} /> : <MetaSkeleton />}</MetaList>
      )}
      <div className="flex flex-col gap-3 border-t border-border pt-3">{isFailed ? <DetailError query={query} number={row.number} /> : response?.ok === true ? <DetailBody body={response.detail.body} /> : <BodySkeleton />}</div>
    </DetailPane>
  )
}
