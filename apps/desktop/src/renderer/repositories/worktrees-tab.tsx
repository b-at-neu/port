// The repo page's Worktrees tab.
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { DetailPane } from '@/renderer/components/detail-pane'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { PageStates } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { StatusPill } from '@/renderer/components/status-pill'
import type { PillStatus } from '@/types/components'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { formatTimeOfDay } from '@/renderer/lib/time'
import type { ForcedFlags, InspectedWorktree, WorktreesReport } from '@/types/reclaimer'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { useListSelection } from '@/renderer/app/list-selection'
import { REPO_INVOKE_ERROR } from '@/renderer/repositories/copy'
import { forcedConfirm, forcedPending, forcedReclaimFor, forcedToast, purgeConfirm, purgePending, purgeToast, reclaimConfirm, reclaimPending, reclaimToast } from '@/renderer/repositories/worktrees-model'
import { failureCopy, forcedActionLabel, LOCKED_IN_USE_HINT, needsAttentionCount, NOTHING_TO_RECLAIM_TOOLTIP, producerCopy } from '@/renderer/repositories/worktrees-copy'

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
      {lockedInUse ? <p className="text-small text-muted-foreground">{LOCKED_IN_USE_HINT}</p> : null}
    </DetailPane>
  )
}

export function WorktreesTab({ repoId, entry }: { readonly repoId: RepoId; readonly entry: RepositoryEntry }) {
  const snapshotQuery = useIpcQuery('board.snapshot')
  const worktreesLastSuccessAt = snapshotQuery.data?.health.find((h) => h.repoId === repoId)?.worktrees.lastSuccessAt ?? null
  const query = useQuery(ipcQueryOptions('worktrees.report', { id: repoId }, [worktreesLastSuccessAt]))
  const report: WorktreesReport | undefined = query.data

  return (
    <PageStates
      loading={
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      }
      state={pageState({ data: report, status: query.status }, () => false)}
      errorMessage={REPO_INVOKE_ERROR}
      onRetry={() => void query.refetch()}
      empty={null}
    >
      {report === undefined ? null : report.ok ? (
        <WorktreesView report={report} repoId={repoId} repo={'config' in entry ? entry.config.repo : ''} onRefresh={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-2 p-4">
          <ErrorBanner message={failureCopy(report)} />
          <Button variant="outline" size="small" onClick={() => void query.refetch()} className="self-start">
            Inspect again
          </Button>
        </div>
      )}
    </PageStates>
  )
}

function WorktreesView({ report, repoId, repo, onRefresh }: { readonly report: Extract<WorktreesReport, { ok: true }>; readonly repoId: RepoId; readonly repo: string; readonly onRefresh: () => void }) {
  const { worktrees } = report
  const selection = useListSelection(worktrees.map((w) => w.path))
  const reclaim = useActionMutation('worktrees.reclaim', {
    confirm: (input) => reclaimConfirm(worktrees, input.issue),
    toast: { pending: (input) => reclaimPending(worktrees, input.issue), result: (result) => reclaimToast(result) },
    invalidates: ['worktrees.report'],
    onResult: () => selection.clear(),
  })
  const forced = useActionMutation('worktrees.reclaim', {
    confirm: (input) => forcedConfirm(worktrees, input.force),
    toast: { pending: (input) => forcedPending(input.force), result: (result, input) => forcedToast(input.force, result) },
    invalidates: ['worktrees.report'],
    onResult: () => selection.clear(),
  })
  const purge = useActionMutation('worktrees.purge', {
    confirm: (input) => purgeConfirm(input.path),
    toast: { pending: (input) => purgePending(input.path), result: (result) => purgeToast(result) },
    invalidates: ['worktrees.report'],
  })

  const reclaimableCount = worktrees.filter((w) => w.reclaimable).length
  const selectedWorktree = worktrees.find((w) => w.path === selection.selectedKey) ?? null
  const selectedForced = selectedWorktree === null ? null : forcedReclaimFor(selectedWorktree)

  return (
    <div className="flex min-h-full flex-1 overflow-hidden" {...selection.surfaceProps()}>
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
              {report.registered} registered · {reclaimableCount} reclaimable · {needsAttentionCount(worktrees)} need attention
            </span>
            <div className="flex items-center gap-2">
              <span className="text-meta">Checked {formatTimeOfDay(report.readAt)}</span>
              <Button variant="ghost" size="small" onClick={onRefresh}>
                Refresh
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="small" disabled={reclaimableCount === 0} onClick={() => reclaim.request({ id: repoId, issue: null, force: null })}>
                      Reclaim {reclaimableCount}
                    </Button>
                  </span>
                </TooltipTrigger>
                {reclaimableCount === 0 ? <TooltipContent>{NOTHING_TO_RECLAIM_TOOLTIP}</TooltipContent> : null}
              </Tooltip>
            </div>
          </div>
        </div>
        {worktrees.length === 0 ? (
          <EmptyState icon={RefreshCw} message="No linked worktrees. Only the main checkout is registered." className="p-6" />
        ) : (
          worktrees.map((worktree) => <WorktreeRow key={worktree.path} worktree={worktree} repo={repo} rowProps={selection.rowProps(worktree.path)} />)
        )}
        {report.orphanDirs.length > 0 ? (
          <div className="flex flex-col gap-1 px-4 py-3">
            <p className="text-small text-foreground">{report.orphanDirs.length} untracked directory(ies) sit beside a registered worktree. git worktree prune can&apos;t clear these.</p>
            {report.orphanDirs.map((dir) => (
              <div key={dir} className="flex items-center gap-2">
                <p className="truncate font-mono text-meta text-muted-foreground">{dir}</p>
                <Button variant="ghost" size="small" onClick={() => purge.request({ id: repoId, path: dir })}>
                  Delete
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {selectedWorktree !== null ? (
        <WorktreeDetailPane
          worktree={selectedWorktree}
          onClose={() => selection.clear()}
          onReclaim={selectedWorktree.reclaimable && selectedWorktree.issue !== null ? () => reclaim.request({ id: repoId, issue: selectedWorktree.issue, force: null }) : null}
          forced={selectedForced}
          onForced={() => selectedForced !== null && forced.request({ id: repoId, issue: null, force: { path: selectedWorktree.path, ...selectedForced } })}
          lockedInUse={selectedWorktree.state === 'locked' && !selectedWorktree.otherwiseReclaimable}
        />
      ) : null}
      {reclaim.confirmDialog}
      {forced.confirmDialog}
      {purge.confirmDialog}
    </div>
  )
}
