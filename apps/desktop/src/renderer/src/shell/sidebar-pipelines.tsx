// The Pipelines section — one collapsible row per repo, its run-state menu, its nested sessions.
import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { StatusPillMenu } from '../components/status-pill-menu'
import { useIpcQuery } from '../data/query'
import { pipelinesModel } from './pipelines-model'
import type { PipelineRow } from './pipelines-model'
import { useRunStateCommand } from './run-state-command'
import { shellPrefs, setRepoCollapsed } from './prefs'
import { ROUTE_IDS } from '../router/routes'

/** #331: `terminal`/`unreadable` ownership disables Run and Drain outright —
 *  neither ever reaches a currently-running/-draining row, since the pill
 *  itself never reads `Running`/`Draining` under either verdict. */
function ownershipDisabledReason(owner: Extract<PipelineRow, { readonly ready: true }>['owner'], unreadableMessage: string | null): string | null {
  if (owner === 'terminal') return 'Your terminal cockpit runs this repo'
  if (owner === 'unreadable') return `.agents/cockpit.json can't be read (${unreadableMessage ?? 'unknown reason'})`
  return null
}

function RunStateMenu({ row }: { readonly row: Extract<PipelineRow, { readonly ready: true }> }) {
  const runState = useRunStateCommand()
  const ownershipReason = ownershipDisabledReason(row.owner, row.unreadableMessage)
  return (
    <StatusPillMenu
      status={row.pill.status}
      label={row.pill.label}
      pending={runState.pending}
      items={[
        {
          key: 'run',
          label: 'Run',
          hint: 'start dispatching',
          current: row.pill.label === 'Running',
          disabledReason: row.pill.label === 'Running' ? 'Already running' : ownershipReason,
          onSelect: () => runState.run(row.repoId, row.name),
        },
        {
          key: 'drain',
          label: 'Drain',
          hint: 'finish in-flight',
          current: row.pill.label === 'Draining',
          disabledReason: row.pill.label === 'Draining' ? 'Already draining' : ownershipReason,
          onSelect: () => runState.drain(row.repoId, row.name),
        },
        { key: 'pause', label: 'Pause', hint: 'stop now', current: row.pill.label === 'Paused', disabledReason: row.pill.label === 'Paused' ? 'Already paused' : null, onSelect: () => runState.requestPause(row.repoId, row.name, row.inFlight) },
        ...(row.owner === 'terminal'
          ? [{ key: 'take-over', label: 'Take over…', hint: "the terminal isn't running", current: false, disabledReason: null, onSelect: () => runState.requestTakeOver(row.repoId, row.name) }]
          : []),
      ]}
    />
  )
}

function RepoRow({ row, collapsed, onToggle }: { readonly row: PipelineRow; readonly collapsed: boolean; readonly onToggle: () => void }) {
  if (!row.ready) {
    return (
      <Link to={ROUTE_IDS.repos} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent">
        <span className="w-3.5 shrink-0" />
        <span className="flex-1 truncate" title={row.name}>
          {row.name}
        </span>
        <span className="rounded-full bg-idle-pill px-1.5 py-0.5 text-meta text-idle-pill-foreground">Not ready</span>
      </Link>
    )
  }

  return (
    <div>
      <div className="flex h-7 items-center gap-1.5 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent">
        <button type="button" onClick={onToggle} className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={collapsed ? `Expand ${row.name}` : `Collapse ${row.name}`}>
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
        <span className="flex-1 truncate" title={row.name}>
          {row.name}
        </span>
        {collapsed && row.needsYou ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention-dot animate-pulse" /> : null}
        <RunStateMenu row={row} />
      </div>
      {!collapsed && row.sessions.length > 0 ? (
        <div className="flex flex-col">
          {row.sessions.map((session) => (
            <Link key={session.key} to={ROUTE_IDS.board} className="flex h-6.5 items-center gap-1.5 rounded-md py-0 pr-2 pl-8 text-small text-foreground-secondary hover:bg-accent">
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  session.dot === 'attention' ? 'bg-attention-dot animate-pulse' : session.dot === 'working' ? 'bg-working-dot' : 'bg-idle-dot',
                )}
              />
              <span className="truncate">{session.label}</span>
              <span className="sr-only">{session.dot === 'attention' ? 'Needs you' : session.dot === 'working' ? 'Working' : 'Idle'}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function SidebarPipelines() {
  const repos = useIpcQuery('repos:list')
  const snapshot = useIpcQuery('board:snapshot')
  const navigate = useNavigate()
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
        <EmptyState icon={ChevronRight} message="No repositories yet." action={{ label: 'Add a repository', onClick: () => void navigate({ to: ROUTE_IDS.repos }) }} className="px-2 py-2 text-left" />
      ) : (
        pipelinesModel(repos.data.repositories, snapshot.data).map((row) => (
          <RepoRow key={row.repoId} row={row} collapsed={row.ready && collapsedRepos.has(row.repoId)} onToggle={() => toggle(row.repoId)} />
        ))
      )}
    </div>
  )
}
