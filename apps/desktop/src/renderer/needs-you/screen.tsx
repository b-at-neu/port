// The Needs you screen — everything waiting on the operator, newest first,
// each with its action inline.
import { useState } from 'react'
import { RefreshCw, Inbox } from 'lucide-react'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { NeedsYouItem } from '@/renderer/components/needs-you-item'
import { useIpcQuery, ipcQueryOptions } from '@/renderer/data/query'
import { useQueryClient } from '@tanstack/react-query'
import { needsYouItems } from '@/renderer/board/needs-you'
import type { NeedsYouItem as NeedsYouItemModel } from '@/types/board'
import { registerListNavigator } from '@/renderer/shell/stores'
import { useListSelection } from '@/renderer/shell/list-selection'
import { REFRESH_FAILED_TOAST, needsYouLeadCopy, refreshedToast } from '@/renderer/needs-you/copy'
import { BlockerAnswer } from '@/renderer/needs-you/blocker-answer'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { actionFor, runAction, runSecondaryAction } from '@/renderer/needs-you/actions'
import { toast } from 'sonner'
import { QuestionCard } from '@/renderer/session/question-card'
import { invoke } from '@/renderer/data/invoke'
import { QUESTION_SKIPPED_MESSAGE } from '@/renderer/session/interaction-copy'

function itemKey(item: NeedsYouItemModel): string {
  return `${item.kind}:${String(item.repoId)}:${String(item.number)}`
}

function hasDetail(item: NeedsYouItemModel): boolean {
  if (item.kind === 'held') return item.held.reason === 'contended' && item.held.contention !== null
  if (item.kind === 'stage-question') return true
  if (item.kind === 'stage-denial') return true
  if (item.kind === 'stage-blocked') return true
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
  const snapshotQuery = useIpcQuery('board:snapshot')
  const sessionsQuery = useIpcQuery('session:list')
  const queryClient = useQueryClient()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const sessionListKey = ipcQueryOptions('session:list').queryKey
  const now = new Date()

  const items = snapshotQuery.data !== undefined ? needsYouItems(snapshotQuery.data, now, sessionsQuery.data ?? []) : []
  const selection = useListSelection(items.map(itemKey))

  registerListNavigator('needsYou', {
    next: () => selection.next(),
    prev: () => selection.prev(),
    open: () => {
      const item = items.find((candidate) => itemKey(candidate) === selection.selectedKey)
      if (item !== undefined) runRowAction(item)
    },
  })

  async function refresh({ announce }: { readonly announce: boolean }): Promise<void> {
    setRefreshing(true)
    try {
      const fresh = await invoke('board:refresh', {})
      queryClient.setQueryData(ipcQueryOptions('board:snapshot').queryKey, fresh)
      await queryClient.refetchQueries({ queryKey: sessionListKey })
      if (announce) {
        const sessions = queryClient.getQueryData<readonly HostedSessionSnapshot[]>(sessionListKey) ?? []
        toast(refreshedToast(needsYouItems(fresh, new Date(), sessions).length))
      }
    } catch (error) {
      console.error('Failed to refresh the board', error)
      toast(REFRESH_FAILED_TOAST)
    } finally {
      setRefreshing(false)
    }
  }

  function runRowAction(item: NeedsYouItemModel): void {
    const key = itemKey(item)
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
                items.map((item) => {
                  const key = itemKey(item)
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
                    />
                  )
                })
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
}: {
  readonly item: NeedsYouItemModel
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
  readonly now: Date
  readonly expanded: boolean
  readonly pending: boolean
  readonly onToggle: () => void
  readonly onAction: () => void
}) {
  const action = actionFor(item)
  return (
    <div {...rowProps}>
      <NeedsYouItem
        leadCopy={needsYouLeadCopy(item)}
        repo={item.repo}
        at={item.at}
        now={now}
        actionLabel={action.label}
        actionDisabledReason={action.disabledReason}
        actionPending={pending}
        onAction={onAction}
        secondaryActionLabel={action.secondaryLabel}
        onSecondaryAction={action.secondaryLabel !== undefined ? () => runSecondaryAction(item, { onToast: () => undefined }) : undefined}
        expandable={hasDetail(item)}
        expanded={expanded}
        onToggleExpand={onToggle}
      >
        <DetailBody item={item} onSent={onToggle} />
      </NeedsYouItem>
    </div>
  )
}
