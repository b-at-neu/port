// The Releases screen — per ready repository, the upcoming release with the one action its phase allows, then every published release. No `useEffect`: the 60s watch is a query `refetchInterval`.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ExternalLink, Loader2, RefreshCw, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { IconButton } from '@/renderer/components/icon-button'
import { LabelChip } from '@/renderer/components/label-chip'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { StatusPill } from '@/renderer/components/status-pill'
import { invoke } from '@/renderer/data/invoke'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { exactTime, relativeAge } from '@/renderer/backlog/group'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { useListSelection } from '@/renderer/shell/list-selection'
import type { HookOutcome, ReleaseEntry, ReleaseGroupView, ReleaseInfo, ReleaseRunRequest, ReleaseStatus } from '@/types/release'
import { isReadyRepo } from '@/utils/repos'
import type { RepoId } from '@/utils/repos'
import { CutDialog } from '@/renderer/releases/cut-dialog'
import { PublishCard } from '@/renderer/releases/publish-card'
import { ReleasePane } from '@/renderer/releases/release-pane'
import { buildReleaseGroup, refetchIntervalFor, staleSinceAt } from '@/renderer/releases/model'
import {
  DEPENDENCIES_LABEL,
  CUT_RELEASE,
  LATEST_TAG,
  NO_RELEASES,
  NO_REPOSITORIES,
  OPENED_TOAST,
  OPEN_BUMP_PR,
  OPEN_ON_GITHUB,
  OPEN_PR,
  OPEN_RELEASE_PR,
  PREVIOUS_RELEASES,
  PRERELEASE_TAG,
  RELEASES_TITLE,
  WAITING_BUMP_COPY,
  WAITING_ON_YOU,
  abandonedCopy,
  bumpedCopy,
  conflictCopy,
  currentVersionCopy,
  hookFailureCopy,
  mutedLine,
  nothingToReleaseCopy,
  publishedToast,
  runProblemCopy,
  upcomingLabel,
  waitingMergeCopy,
} from '@/renderer/releases/copy'

const MAX_CHIPS = 3
const LINK_CLASS = 'text-primary-text hover:underline'

interface HookNotice {
  readonly version: string
  readonly command: string | null
  readonly outcome: Exclude<HookOutcome, { kind: 'skipped' } | { kind: 'ok' }>
}

function releaseKey(repoId: RepoId, tag: string): string {
  return `${repoId}:${tag}`
}

function ChangeRow({ entry }: { readonly entry: ReleaseEntry }) {
  return (
    <div data-slot="change-row" className="flex h-9 items-center gap-2 px-4 text-body">
      <span className="w-12 shrink-0 font-mono tabular-nums text-muted-foreground">{entry.number === null ? '' : `#${String(entry.number)}`}</span>
      <span className="min-w-24 flex-1 truncate text-foreground">{entry.title}</span>
      <div className="flex min-w-0 max-w-48 gap-1">
        {entry.labels.slice(0, MAX_CHIPS).map((name) => (
          <LabelChip key={name} label={{ name, color: null }} />
        ))}
      </div>
    </div>
  )
}

function PrLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {label}
    </a>
  )
}

interface UpcomingProps {
  readonly status: ReleaseStatus
  readonly pending: boolean
  readonly onCut: () => void
  readonly onRun: (request: Omit<Extract<ReleaseRunRequest, { step: 'open' }>, 'repoId'> | Omit<Extract<ReleaseRunRequest, { step: 'publish' }>, 'repoId'>) => void
}

function PendingButton({ pending, onClick, children }: { readonly pending: boolean; readonly onClick: () => void; readonly children: string }) {
  return (
    <Button size="small" disabled={pending} onClick={onClick}>
      {pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
      {children}
    </Button>
  )
}

function Waiting({ copy, children }: { readonly copy: string; readonly children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-body">
      <StatusPill status="attention" label={WAITING_ON_YOU} />
      <span className="text-foreground">{copy}</span>
      {children}
    </div>
  )
}

function Upcoming({ status, pending, onCut, onRun }: UpcomingProps) {
  const phase = status.phase
  switch (phase.kind) {
    case 'off':
    case 'single-branch':
    case 'misconfigured':
    case 'needs-terminal':
      return <p className="px-4 py-2 text-small text-muted-foreground">{mutedLine(phase.kind)}</p>
    case 'nothing-to-release':
      return <EmptyState icon={Tag} message={nothingToReleaseCopy(status.integration, status.currentVersion)} className="px-4" />
    case 'idle': {
      const changes = status.entries.filter((entry) => !entry.dependency)
      const dependencies = status.entries.filter((entry) => entry.dependency)
      return (
        <div data-slot="release-upcoming">
          <div className="flex h-8 items-center justify-between px-4 text-small font-medium text-foreground-secondary">
            <span>{upcomingLabel(status.candidates)}</span>
            <Button size="small" disabled={pending} onClick={onCut}>
              {CUT_RELEASE}
            </Button>
          </div>
          {status.truncatedNote !== null ? <p className="px-4 py-1 text-meta text-muted-foreground">{status.truncatedNote}</p> : null}
          {changes.map((entry, index) => (
            <ChangeRow key={`${String(entry.number)}-${String(index)}`} entry={entry} />
          ))}
          {dependencies.length > 0 ? <p className="px-4 pt-2 text-meta font-medium text-muted-foreground">{DEPENDENCIES_LABEL}</p> : null}
          {dependencies.map((entry, index) => (
            <ChangeRow key={`${String(entry.number)}-${String(index)}`} entry={entry} />
          ))}
        </div>
      )
    }
    case 'bumped':
      return (
        <div className="flex items-center gap-3 px-4 py-2 text-body">
          <span className="text-foreground">{bumpedCopy(status.integration, phase.version)}</span>
          <PendingButton pending={pending} onClick={() => onRun({ step: 'open', version: phase.version })}>
            {OPEN_RELEASE_PR}
          </PendingButton>
        </div>
      )
    case 'waiting-bump':
      return (
        <Waiting copy={WAITING_BUMP_COPY}>
          {phase.bumpPr === null ? (
            <PendingButton pending={pending} onClick={() => onRun({ step: 'open', version: phase.version })}>
              {OPEN_BUMP_PR}
            </PendingButton>
          ) : (
            <PrLink href={phase.bumpPr.url} label={OPEN_BUMP_PR} />
          )}
          {phase.releasePr === null ? (
            <PendingButton pending={pending} onClick={() => onRun({ step: 'open', version: phase.version })}>
              {OPEN_RELEASE_PR}
            </PendingButton>
          ) : (
            <PrLink href={phase.releasePr.url} label={OPEN_RELEASE_PR} />
          )}
        </Waiting>
      )
    case 'waiting-merge':
      return (
        <Waiting copy={waitingMergeCopy(phase.releasePr, phase.version)}>
          <PrLink href={phase.releasePr.url} label={OPEN_PR} />
        </Waiting>
      )
    case 'ready-to-publish':
      return <PublishCard key={phase.version} status={status} version={phase.version} pending={pending} onPublish={(notes) => onRun({ step: 'publish', version: phase.version, notes })} />
    case 'abandoned':
      return (
        <div className="px-4 py-2">
          <ErrorBanner message={abandonedCopy(phase.releasePr, phase.version)} />
        </div>
      )
    case 'conflict':
      return (
        <div className="px-4 py-2">
          <ErrorBanner message={conflictCopy(phase.branches)} />
        </div>
      )
  }
}

function ReleaseRow({ release, repoId, now, rowProps }: { readonly release: ReleaseInfo; readonly repoId: RepoId; readonly now: Date; readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']> }) {
  return (
    <div data-slot="release-row" data-release={releaseKey(repoId, release.tagName)} {...rowProps} className={`flex h-9 items-center gap-2 px-4 text-body ${rowProps.className}`}>
      <span className="w-20 shrink-0 font-mono text-foreground">{release.tagName}</span>
      <span className="min-w-24 flex-1 truncate text-foreground-secondary">{release.name}</span>
      {release.isLatest ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-meta font-medium text-foreground-secondary">{LATEST_TAG}</span> : null}
      {release.isPrerelease ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-meta font-medium text-foreground-secondary">{PRERELEASE_TAG}</span> : null}
      {release.publishedAt !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-meta text-muted-foreground">{relativeAge(release.publishedAt, now)}</span>
          </TooltipTrigger>
          <TooltipContent>{exactTime(release.publishedAt)}</TooltipContent>
        </Tooltip>
      ) : null}
      <IconButton label={OPEN_ON_GITHUB} onClick={() => window.open(release.url, '_blank', 'noreferrer')}>
        <ExternalLink aria-hidden="true" className="size-3.5" />
      </IconButton>
    </div>
  )
}

export function ReleasesScreen() {
  const reposQuery = useIpcQuery('repos:list')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [cutting, setCutting] = useState<RepoId | null>(null)
  const [pending, setPending] = useState<ReadonlySet<RepoId>>(new Set())
  const [notices, setNotices] = useState<ReadonlyMap<RepoId, HookNotice>>(new Map())
  const now = new Date()

  const readyRepos = reposQuery.data?.ok === true ? reposQuery.data.repositories.filter(isReadyRepo).map((entry) => ({ id: entry.id, repo: entry.config.repo })) : []
  const queries = useQueries({
    queries: readyRepos.map((repo) => ({ ...ipcQueryOptions('release:status', { repoId: repo.id }), refetchInterval: refetchIntervalFor })),
  })
  const likes = queries.map((query) => ({ status: query.status, data: query.data, isError: query.isError, errorMessage: query.error?.message ?? null, dataUpdatedAt: query.dataUpdatedAt }))
  const groups: ReleaseGroupView[] = readyRepos.map((repo, index) => buildReleaseGroup(repo.id, repo.repo, likes[index] ?? { status: 'pending', data: undefined, isError: false, errorMessage: null, dataUpdatedAt: 0 }))

  const releaseKeys = groups.flatMap((group) => (group.kind === 'loaded' ? group.status.releases.map((release) => releaseKey(group.repoId, release.tagName)) : []))
  const selection = useListSelection(releaseKeys)
  const selectedRelease = groups.flatMap((group) => (group.kind === 'loaded' ? group.status.releases.filter((release) => releaseKey(group.repoId, release.tagName) === selection.selectedKey) : []))[0] ?? null

  function setRepoPending(repoId: RepoId, value: boolean): void {
    setPending((previous) => {
      const next = new Set(previous)
      if (value) next.add(repoId)
      else next.delete(repoId)
      return next
    })
  }

  async function run(repoId: RepoId, command: string | null, request: Omit<ReleaseRunRequest, 'repoId'>): Promise<void> {
    setRepoPending(repoId, true)
    try {
      const result = await invoke('release:run', { repoId, ...request } as ReleaseRunRequest)
      if (result.kind === 'opened') toast(OPENED_TOAST)
      else if (result.kind === 'published') {
        toast(publishedToast(request.version), { action: { label: 'Open release', onClick: () => window.open(result.url, '_blank', 'noreferrer') } })
        if (result.hook.kind === 'failed' || result.hook.kind === 'unrunnable') {
          const notice: HookNotice = { version: request.version, command, outcome: result.hook }
          setNotices((previous) => new Map(previous).set(repoId, notice))
        }
      } else toast(runProblemCopy(result))
      await queryClient.invalidateQueries({ queryKey: ['release:status'] })
    } catch (error) {
      console.error('Failed to reach the main process while running a release step', error)
      toast("Couldn't reach the main process to run that release step.")
    }
    setRepoPending(repoId, false)
    setCutting(null)
  }

  function refreshAll(): void {
    for (const query of queries) void query.refetch()
  }

  const stale = staleSinceAt(likes)
  const isFetching = queries.some((query) => query.isFetching)
  const cuttingGroup = groups.find((group) => group.kind === 'loaded' && group.repoId === cutting)

  return (
    <Screen
      header={
        <ScreenHeader className="justify-between">
          <span>{RELEASES_TITLE}</span>
          <div className="flex items-center gap-2">
            {stale !== null ? <span className="text-meta font-normal text-attention-dot">Updated {relativeAge(new Date(stale).toISOString(), now)}</span> : null}
            <Button variant="ghost" size="small" onClick={refreshAll} disabled={isFetching}>
              <RefreshCw aria-hidden="true" className={isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
              Refresh
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
          ) : readyRepos.length === 0 ? (
            <EmptyState icon={Tag} message={NO_REPOSITORIES} action={{ label: 'Open Repositories', onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }} className="px-4 py-6" />
          ) : (
            groups.map((group) => (
              <div key={group.repoId}>
                <div className="flex h-8 items-center justify-between bg-sidebar px-4 text-small font-medium text-foreground-secondary">
                  <span>{group.repo}</span>
                  {group.kind === 'loaded' ? <span className="font-normal tabular-nums text-muted-foreground">{currentVersionCopy(group.status.currentVersion)}</span> : null}
                </div>
                {group.kind === 'loading' ? (
                  <div className="flex flex-col gap-1 px-4 py-2">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                ) : group.kind === 'error' ? (
                  <div className="px-4 py-2">
                    <ErrorBanner message={group.message} />
                  </div>
                ) : (
                  <>
                    <HookBanner notice={notices.get(group.repoId)} />
                    <Upcoming
                      status={group.status}
                      pending={pending.has(group.repoId)}
                      onCut={() => setCutting(group.repoId)}
                      onRun={(request) => void run(group.repoId, group.status.postPublishHook, request)}
                    />
                    <p className="px-4 pt-3 text-meta font-medium text-muted-foreground">{PREVIOUS_RELEASES}</p>
                    {group.status.releases.length === 0 ? (
                      <EmptyState icon={Tag} message={NO_RELEASES} data-slot="releases-empty" className="px-4" />
                    ) : (
                      group.status.releases.map((release) => <ReleaseRow key={release.tagName} release={release} repoId={group.repoId} now={now} rowProps={selection.rowProps(releaseKey(group.repoId, release.tagName))} />)
                    )}
                  </>
                )}
              </div>
            ))
          )}
        </ScreenBody>
        {selectedRelease !== null ? <ReleasePane release={selectedRelease} onClose={() => selection.clear()} /> : null}
      </div>
      {cuttingGroup?.kind === 'loaded' ? (
        <CutDialog open status={cuttingGroup.status} pending={pending.has(cuttingGroup.repoId)} onCancel={() => setCutting(null)} onConfirm={(version) => void run(cuttingGroup.repoId, cuttingGroup.status.postPublishHook, { step: 'open', version })} />
      ) : null}
    </Screen>
  )
}

function HookBanner({ notice }: { readonly notice: HookNotice | undefined }) {
  if (notice === undefined) return null
  return (
    <div className="flex flex-col gap-2 px-4 py-2">
      <ErrorBanner message={hookFailureCopy(notice.version, notice.outcome, notice.command)} />
      {notice.outcome.kind === 'failed' && notice.outcome.stderr.trim() !== '' ? <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta text-foreground">{notice.outcome.stderr.trim()}</pre> : null}
    </div>
  )
}
