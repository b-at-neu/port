// Settings → Repositories — one RepoRow per registered entry, Add repository and Rescan in the card header.
import { useNavigate } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { PageStates } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { SettingsCard } from '@/renderer/components/settings-card'
import { StatusPill } from '@/renderer/components/status-pill'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { problemLabel, REPO_INVOKE_ERROR } from '@/renderer/repositories/copy'
import { addResultToast, registryFailureCopy, repoName } from '@/renderer/repositories/model'
import { useListSelection } from '@/renderer/shell/list-selection'
import { WIDE_CARD } from '@/renderer/settings/copy'

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
    <div data-slot="repo-row" role="button" {...rowProps} onClick={onOpen} onKeyDown={(event) => event.key === 'Enter' && onOpen()} className={`flex h-9 cursor-pointer items-center gap-3 px-2 text-body ${rowProps.className}`}>
      <span className="min-w-0 flex-1 truncate text-foreground">{repoName(entry)}</span>
      <span className="truncate font-mono text-meta text-muted-foreground">{entry.path}</span>
      {entry.diagnostics.length > 0 ? <StatusPill status="attention" label={`${entry.diagnostics.length} warnings`} /> : null}
      <StatusPill status={ready ? 'success' : 'danger'} label={ready ? 'Ready' : problemLabel(entry.problem)} />
    </div>
  )
}

export function RepositoriesTab() {
  const navigate = useNavigate()
  const reposQuery = useIpcQuery('repos.list')
  const repositories = reposQuery.data?.ok === true ? reposQuery.data.repositories : []
  const selection = useListSelection(repositories.map((r) => r.id))
  const add = useActionMutation('repos.add', {
    toast: { result: addResultToast },
    invalidates: ['repos.list'],
    onResult: (result) => {
      if (result.ok && result.outcome === 'already-registered') highlightFor3s(result.existing)
    },
  })

  function openRepo(id: RepoId): void {
    void navigate({ to: ROUTE_IDS.settingsRepo, params: { repoId: id } })
  }

  function highlightFor3s(id: RepoId): void {
    selection.select(id)
    setTimeout(() => selection.clearIfStill(id), 3000)
  }

  return (
    <div className="contents" {...selection.surfaceProps()}>
    <SettingsCard
      title="Repositories"
      className={WIDE_CARD}
      actions={
        <>
          <Button variant="ghost" size="small" onClick={() => void reposQuery.refetch()} disabled={reposQuery.isFetching}>
            Rescan
          </Button>
          <Button size="small" onClick={() => add.request(undefined)} disabled={add.pending}>
            Add repository…
          </Button>
        </>
      }
    >
      <PageStates
        loading={
          <div className="flex flex-col gap-1">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        }
        state={pageState({ data: reposQuery.data, status: reposQuery.status }, (data) => data.ok && data.repositories.length === 0)}
        errorMessage={REPO_INVOKE_ERROR}
        onRetry={() => void reposQuery.refetch()}
        empty={<EmptyState icon={FolderGit2} message="Add a port-managed repository to see its pipeline." action={{ label: 'Add repository', onClick: () => add.request(undefined) }} className="py-6" />}
      >
        {reposQuery.data?.ok === false ? (
          <ErrorBanner message={registryFailureCopy(reposQuery.data.kind)} />
        ) : (
          <div>{repositories.map((entry) => <RepoRow key={entry.id} entry={entry} rowProps={selection.rowProps(entry.id)} onOpen={() => openRepo(entry.id)} />)}</div>
        )}
      </PageStates>
    </SettingsCard>
    </div>
  )
}
