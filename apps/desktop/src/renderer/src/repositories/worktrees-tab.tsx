// The repo page's Worktrees tab.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DetailPane } from '../components/detail-pane'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { StatusPill } from '../components/status-pill'
import type { PillStatus } from '../components/status-pill'
import { ipcQueryOptions } from '../data/query'
import type { InspectedWorktree, WorktreesReport } from '../../../shared/reclaimer/types'
import type { RepoId } from '../../../shared/repos'
import { failureCopy, needsAttentionCount, producerCopy } from './worktrees-copy'

const PILL_STATUS: Readonly<Record<InspectedWorktree['state'], PillStatus>> = {
  active: 'working',
  done: 'success',
  'no-work': 'success',
  locked: 'attention',
  dirty: 'attention',
  unresolved: 'attention',
  outside: 'idle',
}

function WorktreeRow({ worktree, selected, onSelect }: { readonly worktree: InspectedWorktree; readonly selected: boolean; readonly onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
      className={`flex h-9 cursor-pointer items-center gap-3 px-4 text-small outline-none ${selected ? 'bg-selection ring-2 ring-ring ring-inset' : ''}`}
    >
      <span className="w-40 shrink-0 truncate font-mono text-foreground">{worktree.pathBasename}</span>
      <StatusPill status={PILL_STATUS[worktree.state]} label={worktree.state} />
      {worktree.branch !== null ? <span className="truncate font-mono text-meta text-muted-foreground">{worktree.branch}</span> : null}
      {worktree.issue !== null ? <span className="shrink-0 text-meta text-muted-foreground">#{worktree.issue}</span> : null}
    </div>
  )
}

function WorktreeDetailPane({ worktree, onClose }: { readonly worktree: InspectedWorktree; readonly onClose: () => void }) {
  const producer = producerCopy(worktree.producer)
  return (
    <DetailPane onClose={onClose}>
      <h2 className="text-title font-semibold text-foreground">{worktree.pathBasename}</h2>
      <p className="text-small text-foreground">{worktree.reason}</p>
      {worktree.prunable === true ? <p className="text-small text-muted-foreground">Its directory is gone. git worktree prune clears the registration.</p> : null}
      {producer !== null ? <p className="text-small text-muted-foreground">{producer}</p> : null}
    </DetailPane>
  )
}

export function WorktreesTab({ repoId, commandsWorktrees }: { readonly repoId: RepoId; readonly commandsWorktrees: string | null }) {
  const [selected, setSelected] = useState<string | null>(null)
  const query = useQuery({ ...ipcQueryOptions('worktrees:report', { id: repoId }), enabled: false })

  if (commandsWorktrees === null) {
    return (
      <EmptyState
        icon={RefreshCw}
        message="No commands.worktrees in this repository's config, so worktree hygiene is unavailable. Run /port:init in it to install the reclamation script."
        className="p-6"
      />
    )
  }

  if (!query.isFetched && !query.isFetching) {
    return <EmptyState icon={RefreshCw} message="Inspect this repository's worktrees to see what can be reclaimed." action={{ label: 'Inspect worktrees', onClick: () => void query.refetch() }} className="p-6" />
  }

  if (query.isFetching) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Button variant="outline" size="small" disabled className="self-start">
          <RefreshCw aria-hidden="true" className="size-3.5 animate-spin" />
          Inspecting…
        </Button>
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

  const reclaimableCount = report.worktrees.filter((w) => w.reclaimable).length
  const selectedWorktree = report.worktrees.find((w) => w.path === selected) ?? null

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
            </div>
          </div>
        </div>
        {report.worktrees.length === 0 ? (
          <EmptyState icon={RefreshCw} message="No linked worktrees. Only the main checkout is registered." className="p-6" />
        ) : (
          report.worktrees.map((worktree) => <WorktreeRow key={worktree.path} worktree={worktree} selected={worktree.path === selected} onSelect={() => setSelected(worktree.path)} />)
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
        <p className="px-4 pb-3 text-meta text-muted-foreground">Reclaiming removes directories, and port doesn&apos;t write yet. Run /port:worktree-clean in this repository.</p>
      </div>
      {selectedWorktree !== null ? <WorktreeDetailPane worktree={selectedWorktree} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
