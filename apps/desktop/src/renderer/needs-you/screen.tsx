// The Needs you screen — everything waiting on the operator, newest first,
// each with its action inline.
import { useState } from 'react'
import { RefreshCw, Inbox } from 'lucide-react'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Button } from '@/renderer/components/ui/button'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { NeedsYouItem } from '@/renderer/components/needs-you-item'
import { useIpcQuery, ipcQueryOptions } from '@/renderer/data/query'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { router } from '@/renderer/router/router'
import { needsYouItems } from '@/renderer/board/needs-you'
import type { NeedsYouItem as NeedsYouItemModel } from '@/types/board'
import { registerListNavigator } from '@/renderer/shell/stores'
import { useListSelection } from '@/renderer/shell/list-selection'
import { UNDO_LABEL } from '@/renderer/lib/copy'
import { CLEANUP_FAILED_HELP, ENDED_DENIAL_LINE, LAUNCH_FAILED_HELP, LAUNCH_FAILED_NO_DETAIL, REFRESH_FAILED_TOAST, dismissedToast, needsYouLeadCopy, refreshedToast, usageLimitEntryLine } from '@/renderer/needs-you/copy'
import { dismiss, dismissedKeys, undismiss, visibleItems } from '@/renderer/needs-you/dismissed'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'
import { groupNeedsYou } from '@/renderer/needs-you/groups'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import { BlockerAnswer } from '@/renderer/needs-you/blocker-answer'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { actionFor, runAction, runSecondaryAction } from '@/renderer/needs-you/actions'
import { toast } from 'sonner'
import { QuestionCard } from '@/renderer/session/question-card'
import { invoke } from '@/renderer/data/invoke'
import { QUESTION_SKIPPED_MESSAGE } from '@/renderer/session/interaction-copy'

function hasDetail(item: NeedsYouItemModel): boolean {
  if (item.kind === 'held') return item.held.reason === 'contended' && item.held.contention !== null
  if (item.kind === 'usage-limit') return true
  if (item.kind === 'stage-question') return true
  if (item.kind === 'stage-denial') return true
  if (item.kind === 'stage-approval') return true
  if (item.kind === 'stage-blocked') return true
  if (item.kind === 'dispatch-failed') return true
  if (item.kind === 'stage-interrupted') return item.interrupted.reason === 'cleanup-failed'
  return false
}

function DetailBody({ item, onSent }: { readonly item: NeedsYouItemModel; readonly onSent: () => void }) {
  if (item.kind === 'held' && item.held.contention !== null) {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p>Shared files:</p>
        <ul className="list-inside list-disc">
          {item.held.contention.paths.map((path) => (
            <li key={path} className="font-mono">
              {path}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (item.kind === 'usage-limit') {
    return (
      <ul className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        {item.entries.map((entry) => (
          <li key={entry.id}>{usageLimitEntryLine(item, entry)}</li>
        ))}
      </ul>
    )
  }
  if (item.kind === 'stage-question') {
    return (
      <div className="border-t border-border px-4 py-2">
        <StageQuestionCard item={item} />
      </div>
    )
  }
  if (item.kind === 'stage-denial') {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p className="font-mono">
          {item.denial.toolName}: {item.denial.inputSummary}
        </p>
        {item.live ? null : <p>{ENDED_DENIAL_LINE}</p>}
      </div>
    )
  }
  if (item.kind === 'dispatch-failed') {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p className="whitespace-pre-wrap break-words font-mono">{item.record.detail ?? LAUNCH_FAILED_NO_DETAIL}</p>
        <p>{LAUNCH_FAILED_HELP}</p>
      </div>
    )
  }
  if (item.kind === 'stage-interrupted') {
    return (
      <div className="border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <p className="whitespace-pre-wrap break-words font-mono">{item.interrupted.worktree.path}</p>
        <p>{CLEANUP_FAILED_HELP}</p>
      </div>
    )
  }
  if (item.kind === 'stage-approval') {
    return (
      <div className="flex items-start justify-between gap-3 border-t border-border px-4 py-2 text-meta text-muted-foreground">
        <div>
          <p className="font-mono">
            {item.toolName}: {item.path}
          </p>
          <p>This path is protected by sessionRequiredPaths. Approving lets this one edit through; port asks again for the next one.</p>
        </div>
        <Button variant="ghost" size="small" onClick={() => void router.navigate({ to: ROUTE_IDS.session, search: { key: item.sessionKey } })}>
          Open session
        </Button>
      </div>
    )
  }
  if (item.kind === 'stage-blocked') {
    return (
      <>
        {item.text !== null ? <div className="border-t border-border px-4 py-2 font-mono text-meta text-muted-foreground">{item.text}</div> : null}
        <BlockerAnswer sessionKey={item.sessionKey} number={item.number} onSent={onSent} />
      </>
    )
  }
  return null
}

function StageQuestionCard({ item }: { readonly item: Extract<NeedsYouItemModel, { readonly kind: 'stage-question' }> }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(answers: Record<string, string>): Promise<void> {
    setSending(true)
    setError(null)
    try {
      const result = await invoke('session:question:answer', { sessionKey: item.sessionKey, permissionId: item.permissionId, answers })
      if (!result.ok) setError(result.kind)
    } catch (err) {
      console.error('Failed to reach the main process while answering a stage question', err)
      setError('unreachable')
    } finally {
      setSending(false)
    }
  }

  async function skip(): Promise<void> {
    await invoke('session:permission:answer', { sessionKey: item.sessionKey, permissionId: item.permissionId, decision: 'deny', message: QUESTION_SKIPPED_MESSAGE })
  }

  return <QuestionCard questions={item.questions} sending={sending} error={error} onSend={(answers) => void send(answers)} onSkip={() => void skip()} />
}

export function NeedsYouScreen() {
  const search = useSearch({ from: ROUTE_IDS.needsYou })
  const navigate = useNavigate()
  const snapshotQuery = useIpcQuery('board:snapshot')
  const queryClient = useQueryClient()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const sessionListKey = ipcQueryOptions('session:list').queryKey
  const now = new Date()

  const items = useNeedsYouItems()
  const groups = groupNeedsYou(items)
  // Keyboard navigation walks the rows in the order they render.
  const ordered = groups.flatMap((group) => group.items)
  const selection = useListSelection(ordered.map(dismissKeyOf), {
    value: search.focus ?? null,
    onChange: (focus) => void navigate({ to: ROUTE_IDS.needsYou, search: { focus }, replace: true }),
  })

  registerListNavigator('needsYou', {
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

  async function refresh({ announce }: { readonly announce: boolean }): Promise<void> {
    setRefreshing(true)
    try {
      const fresh = await invoke('board:refresh', {})
      queryClient.setQueryData(ipcQueryOptions('board:snapshot').queryKey, fresh)
      await queryClient.refetchQueries({ queryKey: sessionListKey })
      if (announce) {
        const sessions = queryClient.getQueryData<readonly HostedSessionSnapshot[]>(sessionListKey) ?? []
        toast(refreshedToast(visibleItems(needsYouItems(fresh, new Date(), sessions), dismissedKeys()).length))
      }
    } catch (error) {
      console.error('Failed to refresh the board', error)
      toast(REFRESH_FAILED_TOAST)
    } finally {
      setRefreshing(false)
    }
  }

  function runRowAction(item: NeedsYouItemModel): void {
    const key = dismissKeyOf(item)
    const action = actionFor(item)
    if (action.kind === 'retry' || action.kind === 'refresh') setPendingKey(key)
    if (action.kind === 'answer') setExpandedKey(key)
    runAction(item, {
      onToast: (message) => {
        setPendingKey((current) => (current === key ? null : current))
        toast(message)
        void refresh({ announce: false })
      },
    })
  }

  const isStale = snapshotQuery.data !== undefined && snapshotQuery.dataUpdatedAt > 0 && now.getTime() - snapshotQuery.dataUpdatedAt > 5 * 60_000

  return (
    <Screen
      header={
        <ScreenHeader className="justify-between">
          <span>Needs you</span>
          <div className="flex items-center gap-2">
            {isStale ? <span className="text-meta font-normal text-attention-dot">Updated {Math.round((now.getTime() - snapshotQuery.dataUpdatedAt) / 60_000)}m ago</span> : null}
            <button
              type="button"
              onClick={() => void refresh({ announce: true })}
              disabled={refreshing}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw aria-hidden="true" className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
              Refresh
            </button>
          </div>
        </ScreenHeader>
      }
    >
      <ScreenBody variant="list">
        <div>
          {snapshotQuery.status === 'pending' ? (
            <div className="flex flex-col gap-1 px-4 py-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ) : snapshotQuery.status === 'error' ? (
            <div className="px-4 py-2">
              <ErrorBanner message="Can't read the pipeline state. Check that gh is signed in." />
            </div>
          ) : (
            <>
              {items.length === 0 ? (
                <EmptyState icon={Inbox} message="Nothing needs you right now." className="px-4 py-6" data-slot="needs-you-empty" />
              ) : (
                groups.map((group) => (
                  <section key={group.key} aria-label={group.name}>
                    <div className="flex h-9 items-center justify-between border-b border-border px-4 text-meta text-muted-foreground">
                      <span>
                        {group.name} · {group.items.length}
                      </span>
                      <Button variant="ghost" size="small" onClick={() => dismissItems(group.items)}>
                        Dismiss all
                      </Button>
                    </div>
                    {group.items.map((item) => {
                      const key = dismissKeyOf(item)
                      return (
                        <Row
                          key={key}
                          item={item}
                          rowProps={selection.rowProps(key)}
                          now={now}
                          expanded={expandedKey === key}
                          pending={pendingKey === key}
                          onToggle={() => setExpandedKey((c) => (c === key ? null : key))}
                          onAction={() => runRowAction(item)}
                          onSecondaryAction={() =>
                            runSecondaryAction(item, {
                              onToast: (message) => {
                                toast(message)
                                void refresh({ announce: false })
                              },
                            })
                          }
                          onDismiss={() => dismissItems([item])}
                        />
                      )
                    })}
                  </section>
                ))
              )}
            </>
          )}
        </div>
      </ScreenBody>
    </Screen>
  )
}

function Row({
  item,
  rowProps,
  now,
  expanded,
  pending,
  onToggle,
  onAction,
  onSecondaryAction,
  onDismiss,
}: {
  readonly item: NeedsYouItemModel
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
  readonly now: Date
  readonly expanded: boolean
  readonly pending: boolean
  readonly onToggle: () => void
  readonly onAction: () => void
  readonly onSecondaryAction: () => void
  readonly onDismiss: () => void
}) {
  const action = actionFor(item, now)
  return (
    <div {...rowProps}>
      <NeedsYouItem
        leadCopy={needsYouLeadCopy(item, now)}
        repo={item.repo}
        at={item.at}
        now={now}
        actionLabel={action.label}
        actionDisabledReason={action.disabledReason}
        actionPending={pending}
        onAction={onAction}
        secondaryActionLabel={action.secondaryLabel}
        onSecondaryAction={action.secondaryLabel !== undefined ? onSecondaryAction : undefined}
        onDismiss={onDismiss}
        expandable={hasDetail(item)}
        expanded={expanded}
        onToggleExpand={onToggle}
      >
        <DetailBody item={item} onSent={onToggle} />
      </NeedsYouItem>
    </div>
  )
}
