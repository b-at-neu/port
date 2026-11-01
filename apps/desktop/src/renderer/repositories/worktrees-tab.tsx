// The repo page's Worktrees tab.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { DetailPane } from '@/renderer/components/detail-pane'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { StatusPill } from '@/renderer/components/status-pill'
import type { PillStatus } from '@/types/components'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { invoke } from '@/renderer/data/invoke'
import type { ForcedFlags, InspectedWorktree, WorktreesReport } from '@/types/reclaimer'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { useListSelection } from '@/renderer/shell/list-selection'
import { forcedReclaimFor } from '@/renderer/repositories/worktrees-model'
import {
  failureCopy,
  forcedActionLabel,
  forcedConfirmLabel,
  forcedDialogBody,
  forcedDialogIsDestructive,
  forcedDialogTitle,
  forcedReclaimToast,
  forcedUnsupportedNotice,
  lockedInUseHint,
  needsAttentionCount,
  producerCopy,
  purgeConfirmLabel,
  purgeDialogBody,
  purgeDialogTitle,
  purgeResultToast,
  reclaimDialogBody,
  reclaimDialogConfirmLabel,
  reclaimDialogTitle,
  reclaimFailureToast,
  reclaimNothingToReclaimTooltip,
  reclaimResultToast,
} from '@/renderer/repositories/worktrees-copy'

interface PendingForced {
  readonly worktree: InspectedWorktree
  readonly flags: ForcedFlags
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive,
  running,
  onConfirm,
  onCancel,
}: {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly destructive: boolean
  readonly running: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-slot="alert-dialog-content">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
          {destructive ? (
            <AlertDialogAction
              disabled={running}
              onClick={(event) => {
                event.preventDefault()
                onConfirm()
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          ) : (
            <Button disabled={running} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const PILL_STATUS: Readonly<Record<InspectedWorktree['state'], PillStatus>> = {
  active: 'working',
  done: 'success',
  'no-work': 'success',
  locked: 'attention',
  dirty: 'attention',
  unresolved: 'attention',
  outside: 'idle',
}

function orphanName(dir: string): string {
  return dir.split(/[\\/]/).filter((part) => part !== '').pop() ?? dir
}

function issueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${String(issue)}`
}

function WorktreeRow({
  worktree,
  repo,
  rowProps,
}: {
  readonly worktree: InspectedWorktree
  readonly repo: string
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
}) {
  return (
    <div data-slot="worktree-row" role="button" {...rowProps} className={`flex h-9 cursor-pointer items-center gap-3 px-4 text-body ${rowProps.className}`}>
      <span className="w-40 shrink-0 truncate font-mono text-foreground">{worktree.pathBasename}</span>
      <StatusPill status={PILL_STATUS[worktree.state]} label={worktree.state} />
      {worktree.branch !== null ? <span className="truncate font-mono text-meta text-muted-foreground">{worktree.branch}</span> : null}
      {worktree.issue !== null ? (
        <a
          href={issueUrl(repo, worktree.issue)}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 text-meta text-primary-text hover:underline"
        >
          #{worktree.issue}
        </a>
      ) : null}
    </div>
  )
}

function WorktreeDetailPane({
  worktree,
  onClose,
  onReclaim,
  forced,
  onForced,
  lockedInUse,
}: {
  readonly worktree: InspectedWorktree
  readonly onClose: () => void
  readonly onReclaim: (() => void) | null
  readonly forced: ForcedFlags | null
  readonly onForced: () => void
  readonly lockedInUse: boolean
}) {
  const producer = producerCopy(worktree.producer)
  return (
    <DetailPane onClose={onClose}>
      <h2 className="text-title font-semibold text-foreground">{worktree.pathBasename}</h2>
      <p className="text-small text-foreground">{worktree.reason}</p>
      {worktree.prunable === true ? <p className="text-small text-muted-foreground">Its directory is gone. git worktree prune clears the registration.</p> : null}
      {producer !== null ? <p className="text-small text-muted-foreground">{producer}</p> : null}
      {onReclaim !== null ? (
        <Button variant="outline" size="small" onClick={onReclaim} className="self-start">
          Reclaim worktree
        </Button>
      ) : null}
      {forced !== null ? (
        <Button variant="outline" size="small" onClick={onForced} className="self-start">
          {forcedActionLabel(forced)}
        </Button>
      ) : null}
      {lockedInUse ? <p className="text-small text-muted-foreground">{lockedInUseHint()}</p> : null}
    </DetailPane>
  )
}

export function WorktreesTab({ repoId, entry }: { readonly repoId: RepoId; readonly entry: RepositoryEntry }) {
  const commandsWorktrees = 'config' in entry ? entry.config.commands.worktrees : null
  const repo = 'config' in entry ? entry.config.repo : ''
  const [confirmIssue, setConfirmIssue] = useState<number | 'all' | null>(null)
  const [reclaiming, setReclaiming] = useState(false)
  const [pendingForced, setPendingForced] = useState<PendingForced | null>(null)
  const [pendingPurge, setPendingPurge] = useState<string | null>(null)
  const snapshotQuery = useIpcQuery('board:snapshot')
  const worktreesLastSuccessAt = snapshotQuery.data?.health.find((h) => h.repoId === repoId)?.worktrees.lastSuccessAt ?? null
  const query = useQuery(ipcQueryOptions('worktrees:report', { id: repoId }, [worktreesLastSuccessAt]))
  const worktreePaths = query.data?.ok === true ? query.data.worktrees.map((w) => w.path) : []
  const selection = useListSelection(worktreePaths)

  if (commandsWorktrees === null) {
    return (
      <EmptyState
        icon={RefreshCw}
        message="No commands.worktrees in this repository's config, so worktree hygiene is unavailable. Run /port:init in it to install the reclamation script."
        className="p-6"
      />
    )
  }

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  const report: WorktreesReport | undefined = query.data
  if (report === undefined) return null

  if (!report.ok) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <ErrorBanner message={failureCopy(report)} />
        <Button variant="outline" size="small" onClick={() => void query.refetch()} className="self-start">
          Inspect again
        </Button>
      </div>
    )
  }

  const reclaimableRows = report.worktrees.filter((w) => w.reclaimable)
  const reclaimableCount = reclaimableRows.length
  const selectedWorktree = report.worktrees.find((w) => w.path === selection.selectedKey) ?? null
  const selectedForced = selectedWorktree === null ? null : forcedReclaimFor(selectedWorktree, report)

  async function runReclaim(issue: number | null): Promise<void> {
    setReclaiming(true)
    try {
      const result = await invoke('worktrees:reclaim', { id: repoId, issue, force: null })
      if (result.ok) toast(reclaimResultToast(result))
      else toast(reclaimFailureToast(result))
      await query.refetch()
    } catch (error) {
      console.error('Failed to reclaim worktrees', error)
    }
    setReclaiming(false)
    setConfirmIssue(null)
    selection.clear()
  }

  async function runForced(target: PendingForced): Promise<void> {
    setReclaiming(true)
    try {
      const result = await invoke('worktrees:reclaim', { id: repoId, issue: null, force: { path: target.worktree.path, ...target.flags } })
      if (result.ok) toast(forcedReclaimToast(target.worktree.pathBasename, result))
      else toast(reclaimFailureToast(result))
      await query.refetch()
    } catch (error) {
      console.error('Failed to reclaim worktree', error)
    }
    setReclaiming(false)
    setPendingForced(null)
    selection.clear()
  }

  async function runPurge(path: string): Promise<void> {
    setReclaiming(true)
    try {
      const result = await invoke('worktrees:purge', { id: repoId, path })
      if (result.ok) toast(purgeResultToast(result))
      else toast(reclaimFailureToast(result))
      await query.refetch()
    } catch (error) {
      console.error('Failed to delete directory', error)
    }
    setReclaiming(false)
    setPendingPurge(null)
  }

  const forcedSupported = report.forcedActions === 'supported'

  const confirmTarget =
    confirmIssue === 'all'
      ? { count: reclaimableCount, singleName: null }
      : confirmIssue !== null
        ? { count: 1, singleName: report.worktrees.find((w) => w.issue === confirmIssue)?.pathBasename ?? null }
        : null

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 px-4 py-3">
          {report.githubResolution === 'unavailable' ? (
            <p className="text-small text-attention-dot">
              GitHub couldn&apos;t be reached, so a finished worktree can&apos;t be told from an unresolved one. Only worktrees with nothing to lose are shown as reclaimable.
            </p>
          ) : null}
          {report.porcelainJoin === 'unavailable' ? (
            <p className="text-small text-attention-dot">Couldn&apos;t read this repository&apos;s worktree list directly, so a registered-but-missing directory isn&apos;t flagged.</p>
          ) : null}
          {!forcedSupported ? <p className="text-small text-attention-dot">{forcedUnsupportedNotice()}</p> : null}
          <div className="flex items-center justify-between gap-2 text-small text-muted-foreground">
            <span>
              {report.registered} registered · {reclaimableCount} reclaimable · {needsAttentionCount(report.worktrees)} need attention
            </span>
            <div className="flex items-center gap-2">
              <span className="text-meta">Checked {new Date(report.readAt).toLocaleTimeString()}</span>
              <Button variant="ghost" size="small" onClick={() => void query.refetch()}>
                Refresh
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="small" disabled={reclaimableCount === 0} onClick={() => setConfirmIssue('all')}>
                      Reclaim {reclaimableCount}
                    </Button>
                  </span>
                </TooltipTrigger>
                {reclaimableCount === 0 ? <TooltipContent>{reclaimNothingToReclaimTooltip()}</TooltipContent> : null}
              </Tooltip>
            </div>
          </div>
        </div>
        {report.worktrees.length === 0 ? (
          <EmptyState icon={RefreshCw} message="No linked worktrees. Only the main checkout is registered." className="p-6" />
        ) : (
          report.worktrees.map((worktree) => <WorktreeRow key={worktree.path} worktree={worktree} repo={repo} rowProps={selection.rowProps(worktree.path)} />)
        )}
        {report.orphanDirs.length > 0 ? (
          <div className="flex flex-col gap-1 px-4 py-3">
            <p className="text-small text-foreground">{report.orphanDirs.length} untracked directory(ies) sit beside a registered worktree. git worktree prune can&apos;t clear these.</p>
            {report.orphanDirs.map((dir) => (
              <div key={dir} className="flex items-center gap-2">
                <p className="truncate font-mono text-meta text-muted-foreground">{dir}</p>
                {forcedSupported ? (
                  <Button variant="ghost" size="small" onClick={() => setPendingPurge(dir)}>
                    Delete
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {selectedWorktree !== null ? (
        <WorktreeDetailPane
          worktree={selectedWorktree}
          onClose={() => selection.clear()}
          onReclaim={selectedWorktree.reclaimable && selectedWorktree.issue !== null ? () => setConfirmIssue(selectedWorktree.issue) : null}
          forced={selectedForced}
          onForced={() => selectedForced !== null && setPendingForced({ worktree: selectedWorktree, flags: selectedForced })}
          lockedInUse={forcedSupported && selectedWorktree.state === 'locked' && !selectedWorktree.otherwiseReclaimable}
        />
      ) : null}
      {pendingForced !== null ? (
        <ConfirmDialog
          title={forcedDialogTitle(pendingForced.worktree.pathBasename, pendingForced.flags, pendingForced.worktree.dirtyFiles)}
          body={forcedDialogBody(pendingForced.worktree.pathBasename, pendingForced.flags, pendingForced.worktree.dirtyFiles)}
          confirmLabel={forcedConfirmLabel(pendingForced.flags)}
          destructive={forcedDialogIsDestructive(pendingForced.flags)}
          running={reclaiming}
          onConfirm={() => void runForced(pendingForced)}
          onCancel={() => setPendingForced(null)}
        />
      ) : null}
      {pendingPurge !== null ? (
        <ConfirmDialog
          title={purgeDialogTitle(orphanName(pendingPurge))}
          body={purgeDialogBody()}
          confirmLabel={purgeConfirmLabel()}
          destructive
          running={reclaiming}
          onConfirm={() => void runPurge(pendingPurge)}
          onCancel={() => setPendingPurge(null)}
        />
      ) : null}
      <AlertDialog open={confirmTarget !== null} onOpenChange={(open) => !open && setConfirmIssue(null)}>
        {confirmTarget !== null ? (
          <AlertDialogContent data-slot="alert-dialog-content">
            <AlertDialogHeader>
              <AlertDialogTitle>{reclaimDialogTitle(confirmTarget.count, confirmTarget.singleName)}</AlertDialogTitle>
              <AlertDialogDescription>{reclaimDialogBody()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={reclaiming}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={reclaiming}
                onClick={(event) => {
                  event.preventDefault()
                  void runReclaim(confirmIssue === 'all' ? null : (confirmIssue ?? null))
                }}
              >
                {reclaimDialogConfirmLabel()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  )
}
