// One repository's row in the sidebar's Pipelines section — collapse toggle, run-state menu, nested stage sessions (DESIGN §4's `RepoPipelineRow`).
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { NEEDS_YOU_TONE } from '@/renderer/lib/phase-tone'
import { PhaseDot } from '@/renderer/components/phase-dot'
import { SessionRow } from '@/renderer/components/session-row'
import { StatusPillMenu } from '@/renderer/components/status-pill-menu'
import { phaseLineOf } from '@/renderer/shell/pipelines-model'
import type { PipelineRow, PipelineSessionRow } from '@/types/shell'
import { cn } from '@/renderer/lib/utils'
import { SELECTED_ROW_CLASS, repoHoldsSelection, repoToggleLabel } from '@/renderer/shell/sidebar-selection'
import { useRunStateCommand } from '@/renderer/shell/run-state-command'
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

export function RepoPipelineRow({ row, collapsed, selectedKey, onToggle }: { readonly row: PipelineRow; readonly collapsed: boolean; readonly selectedKey: string | null; readonly onToggle: () => void }) {
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
        <SessionLinks sessions={row.sessions} selectedKey={selectedKey} />
      </div>
    )
  }

  const holdsSelection = repoHoldsSelection(row, collapsed, selectedKey)
  const toggleLabel = repoToggleLabel(row.name, collapsed, holdsSelection)

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
