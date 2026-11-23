// One repository's group in the sidebar — header with its run-state menu, the four repo screens, then its sessions (DESIGN §4's `RepoGroup`).
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { PhaseDot } from '@/renderer/components/phase-dot'
import { SessionRow } from '@/renderer/components/session-row'
import { StatusPillMenu } from '@/renderer/components/status-pill-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { phaseLineOf } from '@/renderer/shell/pipelines-model'
import { REPO_SCREENS } from '@/renderer/shell/repo-nav-model'
import { LiveSessionEntry } from '@/renderer/shell/sidebar-sessions'
import type { ActiveRepoScreen, PipelineRow, PipelineSessionRow, SidebarSelection } from '@/types/shell'
import type { SessionMarks } from '@/types/hosting'
import { cn } from '@/renderer/lib/utils'
import { SELECTED_ROW_CLASS, isUserSessionSelected, repoHoldsSelection, repoToggleLabel } from '@/renderer/shell/sidebar-selection'
import { useRunStateCommand } from '@/renderer/shell/run-state-command'
import { ROUTE_IDS } from '@/renderer/router/routes'

const SCREEN_ROW_CLASS = 'flex h-7 items-center gap-2 rounded-md px-2 text-body text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** `unreadable` ownership disables Run and Drain outright — the pill itself
 *  never reads `Running`/`Draining` under it. */
function ownershipDisabledReason(owner: Extract<PipelineRow, { readonly ready: true }>['owner'], unreadableMessage: string | null): string | null {
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
          disabledReason: row.pill.label === 'Draining' ? 'Already draining' : row.pill.label === 'Stopped' ? 'Already stopped' : ownershipReason,
          onSelect: () => runState.drain(row.repoId, row.name),
        },
        { key: 'stop', label: 'Stop', hint: 'stop now', current: row.pill.label === 'Stopped', disabledReason: row.pill.label === 'Stopped' ? 'Already stopped' : null, onSelect: () => runState.requestPause(row.repoId, row.name, row.inFlight) },
      ]}
    />
  )
}

function CountPill({ count }: { readonly count: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="rounded-full bg-phase-needs-you-pill px-1.5 py-0.5 text-meta font-medium tabular-nums text-phase-needs-you-pill-foreground">{count}</span>
      </TooltipTrigger>
      <TooltipContent>{count} waiting on you</TooltipContent>
    </Tooltip>
  )
}

function StageLinks({ sessions, selectedKey }: { readonly sessions: readonly PipelineSessionRow[]; readonly selectedKey: string | null }) {
  const navigate = useNavigate()

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
      {sessions.map((session) => (
        <SessionRow
          key={session.key}
          density="nested"
          leading={<PhaseDot tone={session.tone} />}
          title={session.label}
          statusText={session.statusText}
          tooltip={{ title: session.label, line: phaseLineOf(session) }}
          selected={session.key === selectedKey}
          onOpen={() => open(session)}
          marks={null}
        />
      ))}
    </div>
  )
}

interface RepoGroupProps {
  readonly row: PipelineRow
  readonly collapsed: boolean
  readonly selectedKey: string | null
  readonly selection: SidebarSelection
  readonly activeScreen: ActiveRepoScreen | null
  readonly marks: SessionMarks | undefined
  readonly onToggle: () => void
}

function SessionsList({ row, selectedKey, selection, marks }: Pick<RepoGroupProps, 'row' | 'selectedKey' | 'selection' | 'marks'>) {
  const empty = row.sessions.length === 0 && row.userSessions.length === 0
  return (
    <div className="flex flex-col">
      <div className="h-6 pl-8 pr-2 text-meta font-medium leading-6 text-muted-foreground">Sessions</div>
      {empty ? <p className="pl-8 pr-2 pb-1 text-meta text-muted-foreground">No sessions open.</p> : null}
      <StageLinks sessions={row.sessions} selectedKey={selectedKey} />
      {row.userSessions.map((session) => (
        <div key={session.sessionKey} className="pl-6">
          <LiveSessionEntry session={session} marks={marks} selected={isUserSessionSelected(session.sessionKey, selection)} />
        </div>
      ))}
    </div>
  )
}

export function RepoGroup({ row, collapsed, selectedKey, selection, activeScreen, marks, onToggle }: RepoGroupProps) {
  if (!row.ready) {
    return (
      <div>
        <Link to={ROUTE_IDS.settings} search={{ section: 'repositories' }} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-body text-foreground-secondary hover:bg-accent">
          <span className="w-3.5 shrink-0" />
          <span className="flex-1 truncate" title={row.name}>
            {row.name}
          </span>
          <span className="rounded-full bg-idle-pill px-1.5 py-0.5 text-meta text-idle-pill-foreground">Not ready</span>
        </Link>
        {row.sessions.length > 0 || row.userSessions.length > 0 ? <SessionsList row={row} selectedKey={selectedKey} selection={selection} marks={marks} /> : null}
      </div>
    )
  }

  const holds = repoHoldsSelection(row, collapsed, selectedKey, activeScreen, selection)
  const toggleLabel = repoToggleLabel(row.name, collapsed, holds)

  return (
    <div data-slot="repo-group">
      <div className={cn('flex h-7 items-center gap-1.5 rounded-md px-2 text-body text-foreground-secondary hover:bg-accent', holds !== null && SELECTED_ROW_CLASS)}>
        <button type="button" onClick={onToggle} className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={toggleLabel} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
        <span className="flex-1 truncate" title={row.name}>
          {row.name}
        </span>
        {row.needsYouCount > 0 ? <CountPill count={row.needsYouCount} /> : null}
        <RunStateMenu row={row} />
      </div>
      {!collapsed ? (
        <>
          <div className="flex flex-col gap-0.5 py-0.5 pl-6">
            {REPO_SCREENS.map(({ key, to, label, icon: Icon }) => {
              const active = activeScreen?.repoId === row.repoId && activeScreen.screen === key
              return (
                <Link key={key} to={to} search={{ repo: row.repoId }} data-slot="repo-screen" data-active={active} aria-current={active ? 'page' : undefined} className={cn(SCREEN_ROW_CLASS, active && 'bg-accent text-primary-text')}>
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{label}</span>
                  {key === 'needsYou' && row.needsYouCount > 0 ? <CountPill count={row.needsYouCount} /> : null}
                </Link>
              )
            })}
          </div>
          <SessionsList row={row} selectedKey={selectedKey} selection={selection} marks={marks} />
        </>
      ) : null}
    </div>
  )
}
