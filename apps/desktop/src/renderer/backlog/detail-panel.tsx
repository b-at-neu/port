import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, Ban, ChevronDown, ChevronRight, CircleCheck, CircleDot, Clock, Pencil, Play, User, UserX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { IconButton } from '@/renderer/components/icon-button'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { Markdown } from '@/renderer/components/markdown'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useIpcQuery } from '@/renderer/data/query'
import { exactTime, relativeAge } from '@/renderer/backlog/group'
import { assigneeView, epicSummaryView, linkListView } from '@/renderer/backlog/detail'
import {
  BACKLOG_DETAIL_NONE,
  BACKLOG_DETAIL_NO_BODY,
  BACKLOG_DETAIL_RETRY,
  BACKLOG_DETAIL_UNASSIGNED,
  BACKLOG_DETAIL_UNREADABLE,
  BACKLOG_EPIC_SUBISSUES_UNREADABLE,
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
  backlogDetailToggleAria,
  backlogEpicDoneCopy,
  backlogEpicInProgressCopy,
  backlogEpicTruncatedCopy,
} from '@/renderer/backlog/copy'
import type { BacklogDetail, BacklogEpicGroup, BacklogLinkListView, BacklogRowView } from '@/types/backlog'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

function useBacklogDetail(row: BacklogRowView) {
  return useIpcQuery('backlog:detail', { repoId: row.repoId, number: row.number })
}

type DetailQuery = ReturnType<typeof useBacklogDetail>

export function DetailToggle({ open, number, controls, onToggle }: { readonly open: boolean; readonly number: number; readonly controls: string; readonly onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <IconButton label={backlogDetailToggleAria(number, open)} expanded={open} controls={controls} slot="backlog-detail-toggle" onClick={onToggle}>
      <Chevron aria-hidden="true" className="size-4" />
    </IconButton>
  )
}

function MetaRow({ children }: { readonly children: ReactNode }) {
  return (
    <div data-slot="backlog-detail-meta" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground">
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

function LinkValues({ items }: { readonly items: readonly { readonly number: number; readonly title: string; readonly url: string; readonly closed?: boolean }[] }) {
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

function PanelRoot({ id, slot, number, children }: { readonly id: string; readonly slot: string; readonly number: number; readonly children: ReactNode }) {
  return (
    <div id={id} role="region" aria-label={backlogDetailRegionAria(number)} data-slot={slot} data-keeps-selection className="flex flex-col gap-3 pb-3 pl-26 pr-4 pt-1">
      {children}
    </div>
  )
}

function TicketMeta({ detail, now }: { readonly detail: BacklogDetail; readonly now: Date }) {
  const assignee = assigneeView(detail.assignees)
  return (
    <MetaRow>
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
        <span>{relativeAge(detail.updatedAt, now)}</span>
      </MetaItem>
      <MetaItem icon={assignee.kind === 'unassigned' ? UserX : User} name={BACKLOG_META_ASSIGNEE} field="assignee">
        <span>{assignee.kind === 'unassigned' ? BACKLOG_DETAIL_UNASSIGNED : assignee.text}</span>
      </MetaItem>
    </MetaRow>
  )
}

export function TicketDetailPanel({ row, id, now }: { readonly row: BacklogRowView; readonly id: string; readonly now: Date }) {
  const query = useBacklogDetail(row)
  const response = query.data
  return (
    <PanelRoot id={id} slot="backlog-detail" number={row.number}>
      {failed(query) ? (
        <DetailError query={query} number={row.number} />
      ) : response?.ok === true ? (
        <>
          <DetailBody body={response.detail.body} />
          <TicketMeta detail={response.detail} now={now} />
        </>
      ) : (
        <>
          <BodySkeleton />
          <Skeleton className="h-4 w-64" />
        </>
      )}
    </PanelRoot>
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
          <span>{relativeAge(createdAt, now)}</span>
        </MetaItem>
      ) : null}
    </>
  )
}

export function EpicInfoPanel({ group, id, now }: { readonly group: BacklogEpicGroup; readonly id: string; readonly now: Date }) {
  const query = useBacklogDetail(group.epic)
  const response = query.data
  return (
    <PanelRoot id={id} slot="backlog-epic-info-panel" number={group.epic.number}>
      {failed(query) ? <DetailError query={query} number={group.epic.number} /> : response?.ok === true ? <DetailBody body={response.detail.body} /> : <BodySkeleton />}
      <MetaRow>
        <EpicSummaryItems group={group} />
        <EpicDetailItems query={query} now={now} />
      </MetaRow>
    </PanelRoot>
  )
}
