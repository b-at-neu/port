// The Repositories list screen — one RepoRow per registered entry, Add
// repository and Rescan in the header, the version footer.
import { useNavigate } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { StatusPill } from '@/renderer/components/status-pill'
import { useIpcMutation, useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { problemLabel, registryBannerCopy } from '@/renderer/repositories/copy'
import { useListSelection } from '@/renderer/shell/list-selection'
import { formatAppVersion } from '@/utils/about/version'

function repoName(entry: RepositoryEntry): string {
  return 'config' in entry ? entry.config.repo : entry.displayName
}

function RepoRow({
  entry,
  rowProps,
  onOpen,
}: {
  readonly entry: RepositoryEntry
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
  readonly onOpen: () => void
}) {
  const ready = 'config' in entry
  return (
    <div data-slot="repo-row" role="button" {...rowProps} onClick={onOpen} onKeyDown={(event) => event.key === 'Enter' && onOpen()} className={`flex h-9 cursor-pointer items-center gap-3 px-4 text-body ${rowProps.className}`}>
      <span className="min-w-0 flex-1 truncate text-foreground">{repoName(entry)}</span>
      <span className="truncate font-mono text-meta text-muted-foreground">{entry.path}</span>
      {entry.diagnostics.length > 0 ? <StatusPill status="attention" label={`${entry.diagnostics.length} warnings`} /> : null}
      <StatusPill status={ready ? 'success' : 'danger'} label={ready ? 'Ready' : problemLabel(entry.problem)} />
    </div>
  )
}

export function RepositoriesScreen() {
  const navigate = useNavigate()
  const reposQuery = useIpcQuery('repos:list')
  const infoQuery = useIpcQuery('app:info')
  const addMutation = useIpcMutation('repos:add')
  const repositories = reposQuery.data?.ok === true ? reposQuery.data.repositories : []
  const selection = useListSelection(repositories.map((r) => r.id))

  function openRepo(id: RepoId): void {
    void navigate({ to: ROUTE_IDS.repo, params: { repoId: id } })
  }

  function highlightFor3s(id: RepoId): void {
    selection.select(id)
    setTimeout(() => selection.clearIfStill(id), 3000)
  }

  async function handleAdd(): Promise<void> {
    try {
      const result = await addMutation.mutateAsync(undefined)
      if (!result.ok) return
      if (result.outcome === 'cancelled') return
      if (result.outcome === 'already-registered') {
        toast('Already added.')
        highlightFor3s(result.existing)
        return
      }
      toast(`Added ${repoNameFor(result.added, result.repositories)}.`)
    } catch (error) {
      console.error('Failed to add a repository', error)
    }
  }

  function repoNameFor(id: RepoId, repositories: readonly RepositoryEntry[]): string {
    const entry = repositories.find((r) => r.id === id)
    return entry !== undefined ? repoName(entry) : id
  }

  return (
    <Screen
      header={
        <ScreenHeader className="justify-between">
          <span>Repositories</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="small" onClick={() => void reposQuery.refetch()} disabled={reposQuery.isFetching}>
              Rescan
            </Button>
            <Button size="small" onClick={() => void handleAdd()} disabled={addMutation.isPending}>
              Add repository…
            </Button>
          </div>
        </ScreenHeader>
      }
    >
      <ScreenBody variant="list">
        <div>
          {reposQuery.status === 'pending' ? (
            <div className="flex flex-col gap-1 px-4 py-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : reposQuery.isError ? (
            <ErrorBanner message="Couldn't reach the main process. Restart port." className="m-4" />
          ) : reposQuery.data?.ok === false ? (
            <ErrorBanner message={registryBannerCopy({ path: 'registry.json', reason: reposQuery.data.kind === 'registry-malformed' ? 'malformed' : reposQuery.data.kind === 'registry-unsupported-version' ? 'unsupported-version' : 'unreadable' })} className="m-4" />
          ) : repositories.length === 0 ? (
            <EmptyState icon={FolderGit2} message="Add a port-managed repository to see its pipeline." action={{ label: 'Add repository', onClick: () => void handleAdd() }} className="px-4 py-6" />
          ) : (
            repositories.map((entry) => <RepoRow key={entry.id} entry={entry} rowProps={selection.rowProps(entry.id)} onOpen={() => openRepo(entry.id)} />)
          )}
        </div>
      </ScreenBody>
      {infoQuery.data !== undefined ? (
        <div className="flex flex-col gap-0.5 border-t border-border px-4 py-2 text-meta text-muted-foreground">
          <span>
            Electron {infoQuery.data.electron} · Chromium {infoQuery.data.chromium} · Node {infoQuery.data.node}
          </span>
          <span>port {formatAppVersion(infoQuery.data.app, infoQuery.data.commit)}</span>
        </div>
      ) : null}
    </Screen>
  )
}
