// Settings → Pipeline: the app-owned session limit and new-session defaults, plus a read-only view of what each repository's own config sets.
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { LimitStepper } from '@/renderer/components/limit-stepper'
import { EmptyState } from '@/renderer/components/empty-state'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import {
  cardReadError,
  CONFIG_ROW_LABEL,
  OFF_LABEL,
  ON_LABEL,
  OPEN_REPOSITORIES,
  OPEN_REPOSITORY,
  PER_REPOSITORY_EMPTY,
  PER_REPOSITORY_NOTE,
  PER_REPOSITORY_SUBJECT,
  PER_REPOSITORY_TITLE,
  SESSION_LIMIT_LABEL,
  SESSION_LIMIT_SUBJECT,
  SESSIONS_TITLE,
  WIDE_CARD,
} from '@/renderer/settings/copy'
import { QueryCard } from '@/renderer/settings/query-card'
import { SessionDefaultsSection } from '@/renderer/settings/session-defaults-section'
import { capacityLine } from '@/renderer/session/rail-model'
import type { ReposListResponse } from '@/types/ipc'
import type { RepositoryEntry } from '@/utils/repos'

type ReadyEntry = Extract<RepositoryEntry, { status: 'ready' }>

function readyEntries(response: ReposListResponse | undefined): readonly ReadyEntry[] {
  return response?.ok === true ? response.repositories.filter((entry): entry is ReadyEntry => 'config' in entry) : []
}

function SessionLimitCard() {
  const capacity = useIpcQuery('session.capacity')
  const sessions = useIpcQuery('session.list')
  const setCapacity = useActionMutation('session.capacitySet', { invalidates: ['session.capacity'] })
  const open = (sessions.data ?? []).filter((s) => s.phase !== 'ended').length

  return (
    <QueryCard title={SESSIONS_TITLE} query={capacity} errorMessage={cardReadError(SESSION_LIMIT_SUBJECT)}>
      {({ limit, ceiling }) => (
        <>
          <div className="flex h-9 items-center justify-between">
            <span className="text-body text-foreground">{SESSION_LIMIT_LABEL}</span>
            <LimitStepper value={limit} min={1} max={ceiling} label={SESSION_LIMIT_LABEL} disabled={setCapacity.pending} onChange={(next) => void setCapacity.perform({ limit: next })} />
          </div>
          <p className="text-small text-muted-foreground">{capacityLine(open, limit)}</p>
        </>
      )}
    </QueryCard>
  )
}

function ConfigRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-small">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}

function RepoConfigBlock({ entry }: { readonly entry: ReadyEntry }) {
  const { config } = entry
  return (
    <div data-slot="settings-repo-config" className="flex flex-col gap-1 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-body font-medium text-foreground">{config.repo}</span>
        <Link to={ROUTE_IDS.settingsRepo} params={{ repoId: entry.id }} search={{ tab: 'overview' }} className="rounded text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {OPEN_REPOSITORY}
        </Link>
      </div>
      <ConfigRow label={CONFIG_ROW_LABEL.plan} value={config.models.plan} />
      <ConfigRow label={CONFIG_ROW_LABEL.impl} value={config.models.impl} />
      <ConfigRow label={CONFIG_ROW_LABEL.review} value={config.models.review} />
      <ConfigRow label={CONFIG_ROW_LABEL.revise} value={config.models.revise} />
      <ConfigRow label={CONFIG_ROW_LABEL.reviewCycleCap} value={String(config.reviewCycleCap)} />
      <ConfigRow label={CONFIG_ROW_LABEL.approvalGate} value={config.modules.approvalGate ? ON_LABEL : OFF_LABEL} />
      <ConfigRow label={CONFIG_ROW_LABEL.budgetGate} value={config.commands.budget !== null ? ON_LABEL : OFF_LABEL} />
      <ConfigRow label={CONFIG_ROW_LABEL.concurrency} value={String(config.concurrency.overlapThreshold)} />
    </div>
  )
}

function RepositoryConfigCard() {
  const repos = useIpcQuery('repos.list')
  const navigate = useNavigate()

  return (
    <QueryCard
      title={PER_REPOSITORY_TITLE}
      className={WIDE_CARD}
      query={repos}
      errorMessage={cardReadError(PER_REPOSITORY_SUBJECT)}
      loading={<Skeleton className="h-24 w-full" />}
      footer={<p className="text-small text-muted-foreground">{PER_REPOSITORY_NOTE}</p>}
      isEmpty={(response) => readyEntries(response).length === 0}
      empty={
        <EmptyState icon={FolderGit2} message={PER_REPOSITORY_EMPTY} action={{ label: OPEN_REPOSITORIES, onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }} className="py-6" />
      }
    >
      {(response) => (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {readyEntries(response).map((entry) => (
            <RepoConfigBlock key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </QueryCard>
  )
}

export function PipelineTab() {
  return (
    <>
      <SessionLimitCard />
      <SessionDefaultsSection />
      <RepositoryConfigCard />
    </>
  )
}
