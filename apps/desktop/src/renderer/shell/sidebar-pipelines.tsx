// The Pipelines section — one collapsible row per repo.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { RepoPipelineRow } from '@/renderer/components/repo-pipeline-row'
import { useIpcQuery } from '@/renderer/data/query'
import { pipelinesModel } from '@/renderer/shell/pipelines-model'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import type { PipelineRow, SidebarSelection } from '@/types/shell'
import { selectedPipelineRowKey, useSidebarSelection } from '@/renderer/shell/sidebar-selection'
import { shellPrefs, setRepoCollapsed } from '@/renderer/shell/prefs'
import { ROUTE_IDS } from '@/renderer/router/routes'

function PipelineRows({ rows, selection, collapsedRepos, onToggle }: { readonly rows: readonly PipelineRow[]; readonly selection: SidebarSelection; readonly collapsedRepos: ReadonlySet<string>; readonly onToggle: (repoId: string) => void }) {
  const selectedKey = selectedPipelineRowKey(rows, selection)
  return rows.map((row) => <RepoPipelineRow key={row.repoId} row={row} collapsed={row.ready && collapsedRepos.has(row.repoId)} needsYouDot={rows.length > 1} selectedKey={selectedKey} onToggle={() => onToggle(row.repoId)} />)
}

export function SidebarPipelines() {
  const repos = useIpcQuery('repos:list')
  const snapshot = useIpcQuery('board:snapshot')
  const sessions = useIpcQuery('session:list')
  const needsYou = useNeedsYouItems()
  const navigate = useNavigate()
  const selection = useSidebarSelection()
  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(() => new Set(shellPrefs().collapsedRepos))

  function toggle(repoId: string): void {
    const next = collapsedRepos.has(repoId) ? false : true
    setRepoCollapsed(repoId, next)
    setCollapsedRepos(new Set(next ? [...collapsedRepos, repoId] : [...collapsedRepos].filter((id) => id !== repoId)))
  }

  return (
    <div>
      <div className="px-2 py-1.5 text-meta font-medium text-muted-foreground">Pipelines</div>
      {repos.status === 'pending' ? (
        <div className="flex flex-col gap-1 px-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : repos.status === 'error' ? (
        <ErrorBanner message="Couldn't load pipelines. Restart port to try again." className="mx-2" />
      ) : !repos.data.ok ? (
        <ErrorBanner message="Couldn't load pipelines. Restart port to try again." className="mx-2" />
      ) : repos.data.repositories.length === 0 ? (
        <EmptyState icon={ChevronRight} message="No repositories yet." action={{ label: 'Add a repository', onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }} className="px-2 py-2 text-left" />
      ) : (
        <PipelineRows rows={pipelinesModel(repos.data.repositories, snapshot.data, needsYou, sessions.data ?? [])} selection={selection} collapsedRepos={collapsedRepos} onToggle={toggle} />
      )}
    </div>
  )
}
