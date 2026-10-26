// The Pipelines section — one collapsible row per repo, its run-state menu, its nested sessions.
import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { NEEDS_YOU_TONE } from '@/renderer/lib/phase-tone'
import { PhaseDot } from '@/renderer/components/phase-dot'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { StatusPillMenu } from '@/renderer/components/status-pill-menu'
import { useIpcQuery } from '@/renderer/data/query'
import { pipelinesModel } from '@/renderer/shell/pipelines-model'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import type { PipelineRow, PipelineSessionRow, SidebarSelection } from '@/types/shell'
import { cn } from '@/renderer/lib/utils'
import { SELECTED_ROW_CLASS, selectedPipelineRowKey, useSidebarSelection } from '@/renderer/shell/sidebar-selection'
import { useRunStateCommand } from '@/renderer/shell/run-state-command'
import { shellPrefs, setRepoCollapsed } from '@/renderer/shell/prefs'
import { ROUTE_IDS } from '@/renderer/router/routes'

/** `terminal`/`unreadable` ownership disables Run and Drain outright — the pill itself
 *  never reads `Running`/`Draining` under either verdict. */
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
          disabledReason: row.pill.label === 'Draining' ? 'Already draining' : row.pill.label === 'Paused' ? 'Already paused' : ownershipReason,
          onSelect: () => runState.drain(row.repoId, row.name),
        },
        { key: 'pause', label: 'Pause', hint: 'stop now', current: row.pill.label === 'Paused', disabledReason: row.pill.label === 'Paused' ? 'Already paused' : null, onSelect: () => runState.requestPause(row.repoId, row.name, row.inFlight) },
        ...(row.owner === 'terminal'
          ? [{ key: 'take-over', label: 'Take over…', hint: 'the terminal has stopped', current: false, disabledReason: null, onSelect: () => runState.requestTakeOver(row.repoId, row.name) }]
          : []),
      ]}
    />
  )
}

function SessionLinks({ sessions, selectedKey }: { readonly sessions: readonly PipelineSessionRow[]; readonly selectedKey: string | null }) {
  const navigate = useNavigate()
  if (sessions.length === 0) return null

  function open(session: PipelineSessionRow): void {
    if (session.sessionKey !== null) {
      void navigate({ to: ROUTE_IDS.session, search: { key: session.sessionKey } })
    } else if (session.transcript !== null) {
      void navigate({
        to: ROUTE_IDS.transcript,
        params: { sessionId: session.transcript.sessionId },
        search: { agentId: session.transcript.agentId, from: 'pipeline', focusIndex: null, title: session.label, item: { repoId: session.repoId, number: session.number } },
      })
    }
  }

  return (
    <div className="flex flex-col">
      {sessions.map((session) => {
        const selected = session.key === selectedKey
        return (
          <button
            key={session.key}
            type="button"
            onClick={() => open(session)}
            aria-current={selected ? 'page' : undefined}
            className={cn('flex h-6.5 items-center gap-1.5 rounded-md py-0 pr-2 pl-8 text-left text-small text-foreground-secondary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', selected && SELECTED_ROW_CLASS)}
          >
            <PhaseDot tone={session.tone} />
            <span className="truncate">{session.label}</span>
            <span className="sr-only">{session.statusText}</span>
          </button>
        )
      })}
    </div>
  )
}

function RepoRow({ row, collapsed, selectedKey, onToggle }: { readonly row: PipelineRow; readonly collapsed: boolean; readonly selectedKey: string | null; readonly onToggle: () => void }) {
  if (!row.ready) {
    return (
      <div>
        <Link to={ROUTE_IDS.repos} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-body text-foreground-secondary hover:bg-accent">
          <span className="w-3.5 shrink-0" />
          <span className="flex-1 truncate" title={row.name}>
            {row.name}
          </span>
          <span className="rounded-full bg-idle-pill px-1.5 py-0.5 text-meta text-idle-pill-foreground">Not ready</span>
        </Link>
        <SessionLinks sessions={row.sessions} selectedKey={selectedKey} />
      </div>
    )
  }

  const holdsSelection = collapsed && selectedKey !== null && row.sessions.some((session) => session.key === selectedKey)
  const toggleLabel = collapsed ? (holdsSelection ? `Expand ${row.name}, contains the open session` : `Expand ${row.name}`) : `Collapse ${row.name}`

  return (
    <div>
      <div className={cn('flex h-7 items-center gap-1.5 rounded-md px-2 text-body text-foreground-secondary hover:bg-accent', holdsSelection && SELECTED_ROW_CLASS)}>
        <button type="button" onClick={onToggle} className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={toggleLabel}>
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
        <span className="flex-1 truncate" title={row.name}>
          {row.name}
        </span>
        {collapsed && row.needsYou ? <PhaseDot tone={NEEDS_YOU_TONE} /> : null}
        <RunStateMenu row={row} />
      </div>
      {!collapsed ? <SessionLinks sessions={row.sessions} selectedKey={selectedKey} /> : null}
    </div>
  )
}

function PipelineRows({ rows, selection, collapsedRepos, onToggle }: { readonly rows: readonly PipelineRow[]; readonly selection: SidebarSelection; readonly collapsedRepos: ReadonlySet<string>; readonly onToggle: (repoId: string) => void }) {
  const selectedKey = selectedPipelineRowKey(rows, selection)
  return rows.map((row) => <RepoRow key={row.repoId} row={row} collapsed={row.ready && collapsedRepos.has(row.repoId)} selectedKey={selectedKey} onToggle={() => onToggle(row.repoId)} />)
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
        <EmptyState icon={ChevronRight} message="No repositories yet." action={{ label: 'Add a repository', onClick: () => void navigate({ to: ROUTE_IDS.repos }) }} className="px-2 py-2 text-left" />
      ) : (
        <PipelineRows rows={pipelinesModel(repos.data.repositories, snapshot.data, needsYou, sessions.data ?? [])} selection={selection} collapsedRepos={collapsedRepos} onToggle={toggle} />
      )}
    </div>
  )
}
