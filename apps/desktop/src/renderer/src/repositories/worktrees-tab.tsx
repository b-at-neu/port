// The repo page's Worktrees tab.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DetailPane } from '../components/detail-pane'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { StatusPill } from '../components/status-pill'
import type { PillStatus } from '../components/status-pill'
import { ipcQueryOptions, useIpcQuery } from '../data/query'
import { invoke } from '../data/invoke'
import type { InspectedWorktree, WorktreesReport } from '../../../shared/reclaimer/types'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import {
  failureCopy,
  needsAttentionCount,
  producerCopy,
  reclaimDialogBody,
  reclaimDialogConfirmLabel,
  reclaimDialogTitle,
  reclaimFailureToast,
  reclaimNothingToReclaimTooltip,
  reclaimResultToast,
} from './worktrees-copy'

const PILL_STATUS: Readonly<Record<InspectedWorktree['state'], PillStatus>> = {
  active: 'working',
  done: 'success',
  'no-work': 'success',
  locked: 'attention',
  dirty: 'attention',
  unresolved: 'attention',
  outside: 'idle',
}

function issueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${String(issue)}`
}

function WorktreeRow({ worktree, repo, selected, onSelect }: { readonly worktree: InspectedWorktree; readonly repo: string; readonly selected: boolean; readonly onSelect: () => void }) {
  return (
    <div
      data-slot="worktree-row"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
      className={`flex h-9 cursor-pointer items-center gap-3 px-4 text-small outline-none ${selected ? 'bg-selection ring-2 ring-ring ring-inset' : ''}`}
    >
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
}: {
  readonly worktree: InspectedWorktree
  readonly onClose: () => void
  readonly onReclaim: (() => void) | null
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
    </DetailPane>
  )
}

export function WorktreesTab({ repoId, entry }: { readonly repoId: RepoId; readonly entry: RepositoryEntry }) {
  const commandsWorktrees = 'config' in entry ? entry.config.commands.worktrees : null
  const repo = 'config' in entry ? entry.config.repo : ''
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmIssue, setConfirmIssue] = useState<number | 'all' | null>(null)
  const [reclaiming, setReclaiming] = useState(false)
  const snapshotQuery = useIpcQuery('board:snapshot')
  const worktreesLastSuccessAt = snapshotQuery.data?.health.find((h) => h.repoId === repoId)?.worktrees.lastSuccessAt ?? null
  const reportOptions = ipcQueryOptions('worktrees:report', { id: repoId })
  const query = useQuery({ ...reportOptions, queryKey: [...reportOptions.queryKey, worktreesLastSuccessAt] })

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
  const selectedWorktree = report.worktrees.find((w) => w.path === selected) ?? null

  async function runReclaim(issue: number | null): Promise<void> {
    setReclaiming(true)
    try {
      const result = await invoke('worktrees:reclaim', { id: repoId, issue })
      if (result.ok) toast(reclaimResultToast(result))
      else toast(reclaimFailureToast(result))
      await query.refetch()
    } catch (error) {
      console.error('Failed to reclaim worktrees', error)
    }
    setReclaiming(false)
    setConfirmIssue(null)
    setSelected(null)
  }

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
          <div className="flex items-center justify-between gap-2 text-small text-muted-foreground">
            <span>
              {report.registered} registered · {reclaimableCount} reclaimable · {needsAttentionCount(report.worktrees)} need attention
            </span>
            <div className="flex items-center gap-2">
              <span className="text-meta">Checked {new Date(report.readAt).toLocaleTimeString()}</span>
              <Button variant="ghost" size="small" onClick={() => void query.refetch()}>
                Refresh
              </Button>
              <Button
                variant="outline"
                size="small"
                disabled={reclaimableCount === 0}
                title={reclaimableCount === 0 ? reclaimNothingToReclaimTooltip() : undefined}
                onClick={() => setConfirmIssue('all')}
              >
                Reclaim {reclaimableCount}
              </Button>
            </div>
          </div>
        </div>
        {report.worktrees.length === 0 ? (
          <EmptyState icon={RefreshCw} message="No linked worktrees. Only the main checkout is registered." className="p-6" />
        ) : (
          report.worktrees.map((worktree) => (
            <WorktreeRow key={worktree.path} worktree={worktree} repo={repo} selected={worktree.path === selected} onSelect={() => setSelected(worktree.path)} />
          ))
        )}
        {report.orphanDirs.length > 0 ? (
          <div className="flex flex-col gap-1 px-4 py-3">
            <p className="text-small text-foreground">{report.orphanDirs.length} untracked directory(ies) sit beside a registered worktree. git worktree prune can&apos;t clear these.</p>
            {report.orphanDirs.map((dir) => (
              <p key={dir} className="font-mono text-meta text-muted-foreground">
                {dir}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      {selectedWorktree !== null ? (
        <WorktreeDetailPane
          worktree={selectedWorktree}
          onClose={() => setSelected(null)}
          onReclaim={selectedWorktree.reclaimable && selectedWorktree.issue !== null ? () => setConfirmIssue(selectedWorktree.issue) : null}
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
