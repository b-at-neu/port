// Settings → Pipeline: the app-owned session limit and new-session defaults, plus a read-only view of what each repository's own config sets.
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { LimitStepper } from '@/renderer/components/limit-stepper'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { SettingsCard } from '@/renderer/components/settings-card'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ipcQueryOptions, useIpcMutation, useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { cardReadError, WIDE_CARD } from '@/renderer/settings/copy'
import { SessionDefaultsSection } from '@/renderer/settings/session-defaults-section'
import { capacityLine } from '@/renderer/session/rail-model'
import { CAPACITY_SET_FAILED } from '@/renderer/session/rail-copy'
import type { RepositoryEntry } from '@/utils/repos'

function SessionLimitCard() {
  const capacity = useIpcQuery('session:capacity')
  const sessions = useIpcQuery('session:list')
  const setCapacity = useIpcMutation('session:capacity:set')
  const client = useQueryClient()

  if (capacity.status === 'pending') {
    return (
      <SettingsCard title="Sessions">
        <Skeleton className="h-9 w-full" />
      </SettingsCard>
    )
  }
  if (capacity.status === 'error') {
    return (
      <SettingsCard title="Sessions">
        <ErrorBanner message={cardReadError('the session limit')} />
      </SettingsCard>
    )
  }

  const { limit, ceiling } = capacity.data
  const open = (sessions.data ?? []).filter((s) => s.phase !== 'ended').length

  async function setLimit(next: number): Promise<void> {
    try {
      const saved = await setCapacity.mutateAsync({ limit: next })
      client.setQueryData(ipcQueryOptions('session:capacity').queryKey, saved)
    } catch {
      toast(CAPACITY_SET_FAILED)
    }
  }

  return (
    <SettingsCard title="Sessions">
      <div className="flex h-9 items-center justify-between">
        <span className="text-body text-foreground">Session limit</span>
        <LimitStepper value={limit} min={1} max={ceiling} label="Session limit" disabled={setCapacity.isPending} onChange={(next) => void setLimit(next)} />
      </div>
      <p className="text-small text-muted-foreground">{capacityLine(open, limit)}</p>
    </SettingsCard>
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

function RepoConfigBlock({ entry }: { readonly entry: Extract<RepositoryEntry, { status: 'ready' }> }) {
  const { config } = entry
  return (
    <div data-slot="settings-repo-config" className="flex flex-col gap-1 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-body font-medium text-foreground">{config.repo}</span>
        <Link to={ROUTE_IDS.settingsRepo} params={{ repoId: entry.id }} search={{ tab: 'overview' }} className="rounded text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Open repository
        </Link>
      </div>
      <ConfigRow label="Plan model" value={config.models.plan} />
      <ConfigRow label="Implementation model" value={config.models.impl} />
      <ConfigRow label="Review model" value={config.models.review} />
      <ConfigRow label="Revision model" value={config.models.revise} />
      <ConfigRow label="Review cycle cap" value={String(config.reviewCycleCap)} />
      <ConfigRow label="Approval gate" value={config.modules.approvalGate ? 'On' : 'Off'} />
      <ConfigRow label="Budget gate" value={config.commands.budget !== null ? 'On' : 'Off'} />
      <ConfigRow label="Concurrency threshold" value={String(config.concurrency.overlapThreshold)} />
    </div>
  )
}

function RepositoryConfigCard() {
  const repos = useIpcQuery('repos:list')
  const navigate = useNavigate()
  const ready = repos.data?.ok === true ? repos.data.repositories.filter((entry): entry is Extract<RepositoryEntry, { status: 'ready' }> => 'config' in entry) : []

  return (
    <SettingsCard title="Per repository" className={WIDE_CARD}>
      {repos.status === 'pending' ? (
        <Skeleton className="h-24 w-full" />
      ) : repos.status === 'error' ? (
        <ErrorBanner message={cardReadError('repositories')} />
      ) : ready.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          message="Add a repository to see its pipeline settings."
          action={{ label: 'Open Repositories', onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }}
          className="py-6"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {ready.map((entry) => (
            <RepoConfigBlock key={entry.id} entry={entry} />
          ))}
        </div>
      )}
      <p className="text-small text-muted-foreground">Set in the repository&rsquo;s port.config.json, or by a port-overrides block in its CLAUDE.md.</p>
    </SettingsCard>
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
