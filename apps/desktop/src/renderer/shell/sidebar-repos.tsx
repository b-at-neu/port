// The sidebar body — one collapsible group per repository, then the sessions that belong to none.
import { useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { RepoGroup } from '@/renderer/components/repo-group'
import { useIpcQuery } from '@/renderer/data/query'
import { pipelinesModel } from '@/renderer/shell/pipelines-model'
import { activeRepoScreen } from '@/renderer/shell/repo-nav-model'
import { OtherSessions } from '@/renderer/shell/sidebar-sessions'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import { useSessionMarks } from '@/renderer/session/marks'
import { selectedPipelineRowKey, useSidebarSelection } from '@/renderer/shell/sidebar-selection'
import { shellPrefs, setRepoCollapsed } from '@/renderer/shell/prefs'
import { ROUTE_IDS } from '@/renderer/router/routes'
import type { RepoId } from '@/utils/repos'

const LOAD_ERROR = "Couldn't load repositories. Restart port to try again."

export function SidebarRepos() {
  const repos = useIpcQuery('repos:list')
  const snapshot = useIpcQuery('board:snapshot')
  const sessions = useIpcQuery('session:list')
  const needsYou = useNeedsYouItems()
  const marks = useSessionMarks()
  const navigate = useNavigate()
  const selection = useSidebarSelection()
  const location = useLocation()
  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(() => new Set(shellPrefs().collapsedRepos))

  const searchRepo = (location.search as { readonly repo?: RepoId | null }).repo
  const activeScreen = activeRepoScreen(location.pathname, searchRepo)

  function toggle(repoId: string): void {
    const next = !collapsedRepos.has(repoId)
    setRepoCollapsed(repoId, next)
    setCollapsedRepos(new Set(next ? [...collapsedRepos, repoId] : [...collapsedRepos].filter((id) => id !== repoId)))
  }

  if (repos.status === 'pending') {
    return (
      <div className="flex flex-col gap-1 px-2">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    )
  }
  if (repos.status === 'error' || !repos.data.ok) return <ErrorBanner message={LOAD_ERROR} className="mx-2" />
  if (repos.data.repositories.length === 0) {
    return <EmptyState icon={FolderGit2} message="No repositories yet." action={{ label: 'Add a repository', onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }} className="px-2 py-2 text-left" />
  }

  const model = pipelinesModel(repos.data.repositories, snapshot.data, needsYou, sessions.data ?? [], marks.data)
  const selectedKey = selectedPipelineRowKey(model.repos, selection)

  return (
    <div className="flex flex-col gap-1">
      {model.repos.map((row) => (
        <RepoGroup key={row.repoId} row={row} collapsed={row.ready && collapsedRepos.has(row.repoId)} selectedKey={selectedKey} selection={selection} activeScreen={activeScreen} marks={marks.data} onToggle={() => toggle(row.repoId)} />
      ))}
      <OtherSessions sessions={model.otherSessions} marks={marks.data} selection={selection} />
    </div>
  )
}
