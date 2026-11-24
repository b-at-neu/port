// One repository's block on the Releases screen: its upcoming release with the one action its phase allows, then its published releases.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ExternalLink, Loader2, Tag } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { IconButton } from '@/renderer/components/icon-button'
import { StatusPill } from '@/renderer/components/status-pill'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { exactTime, formatAgoSince } from '@/renderer/lib/time'
import type { useListSelection } from '@/renderer/app/list-selection'
import type { HookOutcome, ReleaseGroupView, ReleaseInfo, ReleaseRunRequest, ReleaseRunResult, ReleaseStatus } from '@/types/release'
import type { ActionToast } from '@/types/toast'
import type { RepoId } from '@/utils/repos'
import { CutDialog } from '@/renderer/releases/cut-dialog'
import { MergedPrs } from '@/renderer/releases/merged-prs'
import { PublishCard } from '@/renderer/releases/publish-card'
import {
  LATEST_TAG,
  NO_RELEASES,
  OPENED_TOAST,
  OPENING_PENDING,
  OPEN_BUMP_PR,
  OPEN_ON_GITHUB,
  OPEN_PR,
  OPEN_RELEASE_ACTION,
  OPEN_RELEASE_PR,
  PREVIOUS_RELEASES,
  PRERELEASE_TAG,
  WAITING_BUMP_COPY,
  WAITING_ON_YOU,
  abandonedCopy,
  bumpedCopy,
  conflictCopy,
  currentVersionCopy,
  hookFailureCopy,
  mutedLine,
  noMergedPrsCopy,
  publishedToast,
  publishingPending,
  runProblemCopy,
  waitingMergeCopy,
} from '@/renderer/releases/copy'

const LINK_CLASS = 'text-primary-text hover:underline'

type RowProps = ReturnType<ReturnType<typeof useListSelection>['rowProps']>
type RunStep = Omit<Extract<ReleaseRunRequest, { step: 'open' }>, 'repoId'> | Omit<Extract<ReleaseRunRequest, { step: 'publish' }>, 'repoId'>

interface HookNotice {
  readonly version: string
  readonly command: string | null
  readonly outcome: Exclude<HookOutcome, { kind: 'skipped' } | { kind: 'ok' }>
}

export function releaseKey(repoId: RepoId, tag: string): string {
  return `${repoId}:${tag}`
}

function releaseToast(version: string, result: ReleaseRunResult): ActionToast {
  const plain = { description: null, action: null, cancel: null } as const
  if (result.kind === 'opened') return { ...plain, tone: 'success', title: OPENED_TOAST }
  if (result.kind === 'published') return { ...plain, tone: 'success', title: publishedToast(version), action: { label: OPEN_RELEASE_ACTION, onClick: () => window.open(result.url, '_blank', 'noreferrer') } }
  return { ...plain, tone: 'error', title: runProblemCopy(result) }
}

function PrLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {label}
    </a>
  )
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

interface UpcomingProps {
  readonly status: ReleaseStatus
  readonly now: Date
  readonly pending: boolean
  readonly onCut: () => void
  readonly onRun: (request: RunStep) => void
}

function Upcoming({ status, now, pending, onCut, onRun }: UpcomingProps) {
  const phase = status.phase
  switch (phase.kind) {
    case 'off':
    case 'single-branch':
    case 'misconfigured':
    case 'needs-terminal':
      return <p className="px-4 py-2 text-small text-muted-foreground">{mutedLine(phase.kind)}</p>
    case 'nothing-to-release':
      return <EmptyState icon={Tag} message={noMergedPrsCopy(status.integration, status.sinceTag)} className="px-4" />
    case 'idle':
      return <MergedPrs status={status} pending={pending} onCut={onCut} now={now} />

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

function ReleaseRow({ release, repoId, now, rowProps }: { readonly release: ReleaseInfo; readonly repoId: RepoId; readonly now: Date; readonly rowProps: RowProps }) {
  return (
    <div data-slot="release-row" data-release={releaseKey(repoId, release.tagName)} {...rowProps} className={`flex h-9 items-center gap-2 px-4 text-body ${rowProps.className}`}>
      <span className="w-20 shrink-0 font-mono text-foreground">{release.tagName}</span>
      <span className="min-w-24 flex-1 truncate text-foreground-secondary">{release.name}</span>
      {release.isLatest ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-meta font-medium text-foreground-secondary">{LATEST_TAG}</span> : null}
      {release.isPrerelease ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-meta font-medium text-foreground-secondary">{PRERELEASE_TAG}</span> : null}
      {release.publishedAt !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-meta text-muted-foreground">{formatAgoSince(release.publishedAt, now)}</span>
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

function HookBanner({ notice }: { readonly notice: HookNotice | null }) {
  if (notice === null) return null
  return (
    <div className="flex flex-col gap-2 px-4 py-2">
      <ErrorBanner message={hookFailureCopy(notice.version, notice.outcome, notice.command)} />
      {notice.outcome.kind === 'failed' && notice.outcome.stderr.trim() !== '' ? <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta text-foreground">{notice.outcome.stderr.trim()}</pre> : null}
    </div>
  )
}

interface ReleaseGroupProps {
  readonly group: ReleaseGroupView
  readonly now: Date
  readonly rowProps: (key: string) => RowProps
}

export function ReleaseGroup({ group, now, rowProps }: ReleaseGroupProps) {
  const [cutting, setCutting] = useState(false)
  const [notice, setNotice] = useState<HookNotice | null>(null)
  const run = useActionMutation('release.run', {
    toast: {
      id: (input) => `release:${input.repoId}`,
      pending: (input) => (input.step === 'open' ? OPENING_PENDING : publishingPending(input.version)),
      result: (output, input) => releaseToast(input.version, output),
    },
    invalidates: ['release.status'],
  })

  async function onRun(command: string | null, request: RunStep): Promise<void> {
    const result = await run.perform({ repoId: group.repoId, ...request })
    if (result !== 'unreachable' && result.kind === 'published' && (result.hook.kind === 'failed' || result.hook.kind === 'unrunnable')) {
      setNotice({ version: request.version, command, outcome: result.hook })
    }
  }

  return (
    <div>
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
          <HookBanner notice={notice} />
          <Upcoming status={group.status} now={now} pending={run.pending} onCut={() => setCutting(true)} onRun={(request) => void onRun(group.status.postPublishHook, request)} />
          <p className="px-4 pt-3 text-meta font-medium text-muted-foreground">{PREVIOUS_RELEASES}</p>
          {group.status.releases.length === 0 ? (
            <EmptyState icon={Tag} message={NO_RELEASES} data-slot="releases-empty" className="px-4" />
          ) : (
            group.status.releases.map((release) => <ReleaseRow key={release.tagName} release={release} repoId={group.repoId} now={now} rowProps={rowProps(releaseKey(group.repoId, release.tagName))} />)
          )}
          <CutDialog open={cutting} status={group.status} onCancel={() => setCutting(false)} onConfirm={(version) => void onRun(group.status.postPublishHook, { step: 'open', version })} />
        </>
      )}
    </div>
  )
}
