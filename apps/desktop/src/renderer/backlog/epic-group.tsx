import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { MeterBar } from '@/renderer/components/meter-bar'
import { epicBodyEntries, epicProgressSegments } from '@/renderer/backlog/epics'
import { rowKey } from '@/renderer/backlog/sections'
import { BACKLOG_EPIC_TAG, BACKLOG_WAVES_MAY_SHIFT, backlogEpicProgressAria, backlogEpicProgressCopy, backlogEpicProgressTooltip, backlogEpicToggleAria, backlogEpicTruncatedCopy, backlogWaveLabel } from '@/renderer/backlog/copy'
import type { BacklogEpicGroup, BacklogEpicSummary, BacklogWave, RenderBacklogRow } from '@/types/backlog'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

function Progress({ summary }: { readonly summary: Extract<BacklogEpicSummary, { ok: true }> }) {
  const { done, inProgress, total, truncated } = summary
  const percents = epicProgressSegments(done, inProgress, total)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={`rounded ${FOCUS_RING}`}>
          <span role="progressbar" aria-valuemin={0} aria-valuenow={done} aria-valuemax={total} aria-label={backlogEpicProgressAria(done, total, inProgress)} className="flex shrink-0 items-center gap-1.5">
            <MeterBar
              segments={[
                { percent: percents.done, fill: 'success' },
                { percent: percents.inProgress, fill: 'progress' },
              ]}
            />
            <span className="text-meta tabular-nums text-muted-foreground">{backlogEpicProgressCopy(done, total, inProgress)}</span>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{backlogEpicProgressTooltip(done, inProgress, total)}</p>
        {truncated !== null ? <p>{backlogEpicTruncatedCopy(truncated.shown, truncated.total)}</p> : null}
      </TooltipContent>
    </Tooltip>
  )
}

interface EpicProps {
  readonly group: BacklogEpicGroup
  readonly collapsedEpics: ReadonlySet<string>
  readonly onToggleEpic: (key: string) => void
  readonly renderRow: RenderBacklogRow
  readonly nested?: boolean
  readonly first?: boolean
}

function EpicRow({ group, collapsed, onToggle, renderRow }: { readonly group: BacklogEpicGroup; readonly collapsed: boolean; readonly onToggle: () => void; readonly renderRow: RenderBacklogRow }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return renderRow(group.epic, {
    slot: 'backlog-epic-row',
    leading: (
      <Button variant="ghost" size="icon" className="shrink-0" data-slot="backlog-epic-toggle" aria-expanded={!collapsed} aria-label={backlogEpicToggleAria(group.epic.number, collapsed)} onClick={onToggle}>
        <Chevron aria-hidden="true" className="size-4" />
      </Button>
    ),
    afterTitle: (
      <>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-meta text-foreground-secondary">{BACKLOG_EPIC_TAG}</span>
        {group.summary.ok ? <Progress summary={group.summary} /> : null}
      </>
    ),
  })
}

function WaveBlock({ wave, first, renderRow }: { readonly wave: BacklogWave; readonly first: boolean; readonly renderRow: RenderBacklogRow }) {
  const label = backlogWaveLabel(wave.number)
  const border = first ? '' : 'border-t border-border'
  return (
    <div role="group" aria-label={label} data-slot="backlog-wave" data-wave={wave.number} className={`flex ${border}`}>
      <div className="w-16 shrink-0 pl-4 pt-2.5 text-meta font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1">{wave.rows.map((row) => renderRow(row))}</div>
    </div>
  )
}

function EpicBody({ group, collapsedEpics, onToggleEpic, renderRow }: Omit<EpicProps, 'nested' | 'first'>) {
  const entries = epicBodyEntries(group)
  const note = group.summary.ok && group.summary.wavesMayShift
  if (group.summary.ok && !note && entries.length === 0 && group.unplaced.length === 0) return null
  return (
    <div className="border-t border-border">
      {!group.summary.ok ? (
        <div className="py-2 pl-16 pr-4">
          <ErrorBanner message={group.summary.reason} />
        </div>
      ) : null}
      {note ? (
        <p data-slot="backlog-wave-note" className="py-1.5 pl-4 pr-4 text-meta text-muted-foreground">
          {BACKLOG_WAVES_MAY_SHIFT}
        </p>
      ) : null}
      {entries.map((entry, index) => {
        const first = index === 0 && !note && group.summary.ok
        if (entry.kind === 'wave') return <WaveBlock key={`wave-${String(entry.wave.number)}`} wave={entry.wave} first={first} renderRow={renderRow} />
        const key = rowKey(entry.group.epic.repoId, entry.group.epic.number)
        return <EpicGroup key={key} group={entry.group} collapsedEpics={collapsedEpics} onToggleEpic={onToggleEpic} renderRow={renderRow} nested first={first} />
      })}
      {group.unplaced.length > 0 ? (
        <div data-slot="backlog-unplaced" className={`flex ${entries.length > 0 || !group.summary.ok ? 'border-t border-border' : ''}`}>
          <div className="w-16 shrink-0" />
          <div className="min-w-0 flex-1">{group.unplaced.map((row) => renderRow(row))}</div>
        </div>
      ) : null}
    </div>
  )
}

export function EpicGroup({ group, collapsedEpics, onToggleEpic, renderRow, nested = false, first = false }: EpicProps) {
  const key = rowKey(group.epic.repoId, group.epic.number)
  const collapsed = collapsedEpics.has(key)
  const border = nested ? `pl-4 ${first ? '' : 'border-t border-border'}` : 'border-b border-border'
  return (
    <div data-slot="backlog-epic" data-epic={group.epic.number} data-collapsed={collapsed} data-nested={nested ? 'true' : undefined} className={border}>
      <EpicRow group={group} collapsed={collapsed} onToggle={() => onToggleEpic(key)} renderRow={renderRow} />
      {collapsed ? null : <EpicBody group={group} collapsedEpics={collapsedEpics} onToggleEpic={onToggleEpic} renderRow={renderRow} />}
    </div>
  )
}
