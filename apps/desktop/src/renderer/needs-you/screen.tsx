// The Needs you screen — everything waiting on the operator, newest first, each with its action inline.
import { useState } from 'react'
import { RefreshCw, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Button } from '@/renderer/components/ui/button'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Page } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { EmptyState } from '@/renderer/components/empty-state'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { belongsToRepo } from '@/renderer/board/needs-you'
import { listNavigatorRef } from '@/renderer/app/list-navigator'
import { useListSelection } from '@/renderer/app/list-selection'
import { SHOW_ALL_REPOSITORIES, UNDO_LABEL } from '@/renderer/lib/copy'
import { DISMISS_ALL_LABEL, NEEDS_YOU_READ_ERROR, NEEDS_YOU_TITLE, NOTHING_NEEDS_YOU, REFRESH_LABEL, dismissedToast, needsYouLeadCopy, nothingInRepoCopy, restoredToast, showDismissedAction, showDismissedLabel, staleCopy } from '@/renderer/needs-you/copy'
import { DismissedSection } from '@/renderer/needs-you/dismissed-section'
import { dismiss, undismiss } from '@/renderer/needs-you/dismissed'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'
import { DetailBody } from '@/renderer/needs-you/detail-body'
import { groupNeedsYou } from '@/renderer/needs-you/groups'
import { NeedsYouItem } from '@/renderer/needs-you/item'
import { actionFor, emptyStateOf, hasDetail, intentOf, staleForMs } from '@/renderer/needs-you/model'
import { useNeedsYouActions } from '@/renderer/needs-you/row-actions'
import { useDismissedNeedsYouItems, useNeedsYouItems } from '@/renderer/needs-you/use-items'
import type { NeedsYouItem as NeedsYouItemModel } from '@/types/board'

export function NeedsYouScreen() {
  const search = useSearch({ from: ROUTE_IDS.needsYou })
  const navigate = useNavigate()
  const snapshotQuery = useIpcQuery('board.snapshot')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showDismissed, setShowDismissed] = useState(false)
  const now = new Date()

  const scopedRepo = search.repo ?? null
  const allItems = useNeedsYouItems()
  const items = scopedRepo === null ? allItems : allItems.filter((item) => belongsToRepo(item, scopedRepo))
  const reposQuery = useIpcQuery('repos.list')
  const scopedName = reposQuery.data?.ok === true ? reposQuery.data.repositories.find((entry) => entry.id === scopedRepo) : undefined
  const scopedLabel = scopedName === undefined ? (scopedRepo ?? '') : 'config' in scopedName ? scopedName.config.repo : scopedName.displayName
  const allDismissed = useDismissedNeedsYouItems()
  const dismissedList = scopedRepo === null ? allDismissed : allDismissed.filter((item) => belongsToRepo(item, scopedRepo))
  const dismissedShown = showDismissed && dismissedList.length > 0
  const groups = groupNeedsYou(items)
  const ordered = groups.flatMap((group) => group.items)
  const actions = useNeedsYouActions(items)
  const selection = useListSelection(ordered.map(dismissKeyOf), {
    value: search.focus ?? null,
    onChange: (focus) => void navigate({ to: ROUTE_IDS.needsYou, search: { focus, repo: scopedRepo }, replace: true }),
  })

  function runRowAction(item: NeedsYouItemModel): void {
    if (intentOf(item)?.kind === 'expand') setExpandedKey(dismissKeyOf(item))
    actions.run(item)
  }

  const navigatorRef = listNavigatorRef({
    next: () => selection.next(),
    prev: () => selection.prev(),
    open: () => {
      const item = ordered.find((candidate) => dismissKeyOf(candidate) === selection.selectedKey)
      if (item !== undefined) runRowAction(item)
    },
  })

  function dismissItems(dismissing: readonly NeedsYouItemModel[]): void {
    const keys = dismissing.map(dismissKeyOf)
    dismiss(keys)
    toast(dismissedToast(dismissing), { action: { label: UNDO_LABEL, onClick: () => undismiss(keys) } })
  }

  function restoreItems(restoring: readonly NeedsYouItemModel[]): void {
    undismiss(restoring.map(dismissKeyOf))
    toast(restoredToast(restoring))
  }

  const staleMs = snapshotQuery.data === undefined ? null : staleForMs(snapshotQuery.dataUpdatedAt, now)
  const dismissedSection = dismissedShown ? <DismissedSection items={dismissedList} now={now} onRestore={restoreItems} /> : null
  const emptyState = emptyStateOf({ scoped: scopedRepo !== null, dismissedCount: dismissedList.length, dismissedShown })

  return (
    <Page
      ref={navigatorRef}
      onMouseDown={selection.surfaceProps().onMouseDown}
      header={
        <ScreenHeader className="justify-between">
          <span>{NEEDS_YOU_TITLE}</span>
          <div className="flex items-center gap-2">
            {staleMs === null ? null : <span className="text-meta font-normal text-attention-dot">{staleCopy(staleMs)}</span>}
            {dismissedList.length > 0 ? (
              <Button variant="ghost" size="small" onClick={() => setShowDismissed((open) => !open)}>
                {showDismissedLabel(dismissedList.length, dismissedShown)}
              </Button>
            ) : null}
            <button
              type="button"
              onClick={() => void actions.refresh({ announce: true })}
              disabled={actions.refreshing}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw aria-hidden="true" className={actions.refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {REFRESH_LABEL}
            </button>
          </div>
        </ScreenHeader>
      }
      variant="list"
      state={pageState({ data: snapshotQuery.data, status: snapshotQuery.status }, () => items.length === 0)}
      errorMessage={NEEDS_YOU_READ_ERROR}
      onRetry={() => void snapshotQuery.refetch()}
      empty={
        <>
          {emptyState === 'show-dismissed' ? (
            <EmptyState
              icon={Inbox}
              message={scopedRepo === null ? NOTHING_NEEDS_YOU : nothingInRepoCopy(scopedLabel)}
              action={{ label: showDismissedAction(dismissedList.length), onClick: () => setShowDismissed(true) }}
              className="px-4 py-6"
              data-slot="needs-you-empty"
            />
          ) : null}
          {emptyState === 'all' ? <EmptyState icon={Inbox} message={NOTHING_NEEDS_YOU} className="px-4 py-6" data-slot="needs-you-empty" /> : null}
          {emptyState === 'scoped' ? (
            <EmptyState
              icon={Inbox}
              message={nothingInRepoCopy(scopedLabel)}
              action={{ label: SHOW_ALL_REPOSITORIES, onClick: () => void navigate({ to: ROUTE_IDS.needsYou, search: { focus: null, repo: null } }) }}
              className="px-4 py-6"
              data-slot="needs-you-empty"
            />
          ) : null}
          {dismissedSection}
        </>
      }
    >
      {groups.map((group) => (
        <section key={group.key} aria-label={group.name}>
          <div className="flex h-9 items-center justify-between border-b border-border px-4 text-meta text-muted-foreground">
            <span>
              {group.name} · {group.items.length}
            </span>
            <Button variant="ghost" size="small" onClick={() => dismissItems(group.items)}>
              {DISMISS_ALL_LABEL}
            </Button>
          </div>
          {group.items.map((item) => {
            const key = dismissKeyOf(item)
            const action = actionFor(item, now)
            return (
              <div key={key} {...selection.rowProps(key)}>
                <NeedsYouItem
                  leadCopy={needsYouLeadCopy(item, now)}
                  repo={item.repo}
                  at={item.at}
                  now={now}
                  actionLabel={action.label}
                  actionDisabledReason={action.disabledReason}
                  actionPending={actions.pendingKey === key}
                  onAction={() => runRowAction(item)}
                  secondaryActionLabel={action.secondaryLabel}
                  onSecondaryAction={action.secondaryLabel === undefined ? undefined : () => actions.runSecondary(item)}
                  secondaryActionDisabledReason={action.secondaryDisabledReason ?? null}
                  onDismiss={() => dismissItems([item])}
                  expandable={hasDetail(item)}
                  expanded={expandedKey === key}
                  onToggleExpand={() => setExpandedKey((current) => (current === key ? null : key))}
                >
                  <div data-keeps-selection>
                    <DetailBody item={item} />
                  </div>
                </NeedsYouItem>
              </div>
            )
          })}
        </section>
      ))}
      {dismissedSection}
      {actions.dialogs}
    </Page>
  )
}
