// The Releases screen — per ready repository, the upcoming release with the one action its phase allows, then every published release. No `useEffect`: the 60s watch is a query `refetchInterval`.
import { useQueries } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, Tag } from 'lucide-react'
import { OPEN_REPOSITORIES, SHOW_ALL_REPOSITORIES, releasesNotReadyCopy, unknownRepoCopy } from '@/renderer/lib/copy'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { formatAgoSince } from '@/renderer/lib/time'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { useListSelection } from '@/renderer/app/list-selection'
import type { ReleaseGroupView } from '@/types/release'
import { isReadyRepo } from '@/utils/repos'
import { ReleaseGroup, releaseKey } from '@/renderer/releases/release-group'
import { ReleasePane } from '@/renderer/releases/release-pane'
import { buildReleaseGroup, refetchIntervalFor, staleSinceAt } from '@/renderer/releases/model'
import { NO_REPOSITORIES, REFRESH_LABEL, RELEASES_TITLE } from '@/renderer/releases/copy'

export function ReleasesScreen() {
  const reposQuery = useIpcQuery('repos.list')
  const navigate = useNavigate()
  const now = new Date()

  const scopedRepo = useSearch({ from: ROUTE_IDS.releases }).repo ?? null
  const entries = reposQuery.data?.ok === true ? reposQuery.data.repositories : []
  const readyRepos = entries.filter(isReadyRepo).filter((entry) => scopedRepo === null || entry.id === scopedRepo).map((entry) => ({ id: entry.id, repo: entry.config.repo }))
  const unknownRepo = scopedRepo !== null && reposQuery.data?.ok === true && !entries.some((entry) => entry.id === scopedRepo) ? scopedRepo : null
  const scopedEntry = entries.find((entry) => entry.id === scopedRepo)
  const scopedLabel = scopedEntry === undefined ? '' : 'config' in scopedEntry ? scopedEntry.config.repo : scopedEntry.displayName
  const queries = useQueries({
    queries: readyRepos.map((repo) => ({ ...ipcQueryOptions('release.status', { repoId: repo.id }), refetchInterval: refetchIntervalFor })),
  })
  const likes = queries.map((query) => ({ status: query.status, data: query.data, isError: query.isError, errorMessage: query.error?.message ?? null, dataUpdatedAt: query.dataUpdatedAt }))
  const groups: ReleaseGroupView[] = readyRepos.map((repo, index) => buildReleaseGroup(repo.id, repo.repo, likes[index] ?? { status: 'pending', data: undefined, isError: false, errorMessage: null, dataUpdatedAt: 0 }))

  const releaseKeys = groups.flatMap((group) => (group.kind === 'loaded' ? group.status.releases.map((release) => releaseKey(group.repoId, release.tagName)) : []))
  const selection = useListSelection(releaseKeys)
  const selected = groups.flatMap((group) => (group.kind === 'loaded' ? group.status.releases.filter((release) => releaseKey(group.repoId, release.tagName) === selection.selectedKey).map((release) => ({ release, repoId: group.repoId })) : []))[0] ?? null

  function refreshAll(): void {
    for (const query of queries) void query.refetch()
  }

  const stale = staleSinceAt(likes)
  const isFetching = queries.some((query) => query.isFetching)
  const showAll = { label: SHOW_ALL_REPOSITORIES, onClick: () => void navigate({ to: ROUTE_IDS.releases, search: { repo: null } }) }

  return (
    <Screen
      onMouseDown={selection.surfaceProps().onMouseDown}
      header={
        <ScreenHeader className="justify-between">
          <span>{RELEASES_TITLE}</span>
          <div className="flex items-center gap-2">
            {stale !== null ? <span className="text-meta font-normal text-attention-dot">Updated {formatAgoSince(new Date(stale).toISOString(), now)}</span> : null}
            <Button variant="ghost" size="small" onClick={refreshAll} disabled={isFetching}>
              <RefreshCw aria-hidden="true" className={isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {REFRESH_LABEL}
            </Button>
          </div>
        </ScreenHeader>
      }
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ScreenBody variant="list" className="flex-1">
          {reposQuery.status === 'pending' ? (
            <div className="flex flex-col gap-1 px-4 py-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ) : unknownRepo !== null ? (
            <EmptyState icon={Tag} message={unknownRepoCopy(unknownRepo)} action={showAll} className="px-4 py-6" />
          ) : readyRepos.length === 0 && scopedRepo !== null ? (
            <EmptyState icon={Tag} message={releasesNotReadyCopy(scopedLabel)} action={showAll} className="px-4 py-6" />
          ) : readyRepos.length === 0 ? (
            <EmptyState icon={Tag} message={NO_REPOSITORIES} action={{ label: OPEN_REPOSITORIES, onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }} className="px-4 py-6" />
          ) : (
            groups.map((group) => <ReleaseGroup key={group.repoId} group={group} now={now} rowProps={(key) => selection.rowProps(key)} />)
          )}
        </ScreenBody>
        {selected !== null ? <ReleasePane release={selected.release} repoId={selected.repoId} now={now} onClose={() => selection.clear()} /> : null}
      </div>
    </Screen>
  )
}
