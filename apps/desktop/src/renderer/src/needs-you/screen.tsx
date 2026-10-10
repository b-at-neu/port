// The Needs you screen — everything waiting on the operator, newest first,
// each with its action inline.
import { useState } from 'react'
import { RefreshCw, Inbox } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ScreenHeader } from '../components/screen-header'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { NeedsYouItem } from '../components/needs-you-item'
import { useIpcQuery, ipcQueryOptions } from '../data/query'
import { useQueryClient } from '@tanstack/react-query'
import { needsYouItems } from '../../../shared/board/needs-you'
import type { NeedsYouItem as NeedsYouItemModel } from '../../../shared/board/needs-you'
import { registerListNavigator } from '../shell/stores'
import { needsYouLeadCopy } from './copy'
import { actionFor, runAction, runSecondaryAction } from './actions'
import { toast } from 'sonner'
import { QuestionCard } from '../session/question-card'
import { invoke } from '../data/invoke'
import { QUESTION_SKIPPED_MESSAGE } from '../session/interaction-copy'

function itemKey(item: NeedsYouItemModel): string {
  return `${item.kind}:${String(item.repoId)}:${String(item.number)}`
}

function hasDetail(item: NeedsYouItemModel): boolean {
  if (item.kind === 'held') return item.held.reason === 'contended' && item.held.contention !== null
  if (item.kind === 'stage-question') return true
  if (item.kind === 'stage-denial') return true
  if (item.kind === 'stage-blocked') return item.text !== null
  return false
}

function DetailBody({ item }: { readonly item: NeedsYouItemModel }) {
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
  if (item.kind === 'stage-blocked' && item.text !== null) {
    return <div className="border-t border-border px-4 py-2 font-mono text-meta text-muted-foreground">{item.text}</div>
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
  const [selection, setSelection] = useState(0)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const now = new Date()

  const items = snapshotQuery.data !== undefined ? needsYouItems(snapshotQuery.data, now, sessionsQuery.data ?? []) : []
  const clampedSelection = items.length === 0 ? 0 : Math.min(selection, items.length - 1)

  registerListNavigator('needsYou', {
    next: () => setSelection((s) => Math.min(s + 1, Math.max(items.length - 1, 0))),
    prev: () => setSelection((s) => Math.max(s - 1, 0)),
    open: () => {
      const item = items[clampedSelection]
      if (item !== undefined) runRowAction(item)
    },
  })

  async function refresh(): Promise<void> {
    try {
      const snapshot = await window.port.boardRefresh({})
      queryClient.setQueryData(ipcQueryOptions('board:snapshot').queryKey, snapshot)
    } catch (error) {
      console.error('Failed to refresh the board', error)
      toast('Failed to reach the main process.')
    }
  }

  function runRowAction(item: NeedsYouItemModel): void {
    const key = itemKey(item)
    const action = actionFor(item)
    if (action.kind === 'retry' || action.kind === 'refresh') setPendingKey(key)
    runAction(item, {
      onToast: (message) => {
        setPendingKey((current) => (current === key ? null : current))
        toast(message)
        void refresh()
      },
    })
  }

  const isStale = snapshotQuery.data !== undefined && snapshotQuery.dataUpdatedAt > 0 && now.getTime() - snapshotQuery.dataUpdatedAt > 5 * 60_000

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader className="justify-between">
        <span>Needs you</span>
        <div className="flex items-center gap-2">
          {isStale ? <span className="text-meta font-normal text-attention-dot">Updated {Math.round((now.getTime() - snapshotQuery.dataUpdatedAt) / 60_000)}m ago</span> : null}
          <button type="button" onClick={() => void refresh()} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent">
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Refresh
          </button>
        </div>
      </ScreenHeader>
      <div className="flex-1 overflow-y-auto">
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
              items.map((item, index) => {
                const key = itemKey(item)
                return (
                  <Row
                    key={key}
                    item={item}
                    selected={index === clampedSelection}
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
    </div>
  )
}

function Row({
  item,
  selected,
  now,
  expanded,
  pending,
  onToggle,
  onAction,
}: {
  readonly item: NeedsYouItemModel
  readonly selected: boolean
  readonly now: Date
  readonly expanded: boolean
  readonly pending: boolean
  readonly onToggle: () => void
  readonly onAction: () => void
}) {
  const action = actionFor(item)
  return (
    <div className={selected ? 'ring-2 ring-ring ring-inset' : ''}>
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
        <DetailBody item={item} />
      </NeedsYouItem>
    </div>
  )
}
