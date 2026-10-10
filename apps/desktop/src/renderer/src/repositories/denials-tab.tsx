// The repo page's Denials tab — grouped by command shape or by actor, with attribution, bursts, and a detail pane per row.
import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DetailPane } from '../components/detail-pane'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { StatusPill } from '../components/status-pill'
import { useIpcQuery } from '../data/query'
import { inspectDenials } from '../../../shared/local/inspect'
import type { ActorGroup, ShapeGroup } from '../../../shared/local/inspect'
import type { RepoId } from '../../../shared/repos'
import type { DenialsGroup } from '../router/routes'
import { actorAttributionPill, attributionLineCopy, burstPillCopy, cappedLineCopy, emptyLogCopy, metaStripCopy, noEntriesCopy, readFailedCopy } from './denials-copy'

function relativeOrDash(iso: string | null, now: Date): string {
  if (iso === null) return '—'
  const ms = now.getTime() - Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return `${String(Math.round(hours / 24))}d ago`
}

function absoluteOrDash(iso: string | null): string {
  if (iso === null) return '—'
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString()
}

function ShapeRow({ group, now, selected, onSelect }: { readonly group: ShapeGroup; readonly now: Date; readonly selected: boolean; readonly onSelect: () => void }) {
  return (
    <div
      data-slot="denial-shape-row"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={`flex h-9 cursor-pointer items-center gap-3 px-4 text-small outline-none ${selected ? 'bg-selection ring-2 ring-ring ring-inset' : ''}`}
    >
      <span className="w-56 shrink-0 truncate font-mono text-foreground">{group.shape}</span>
      <span className="shrink-0 text-meta text-muted-foreground">
        {group.counts.deny} denied · {group.counts.miss} missed
      </span>
      <span className="shrink-0 text-meta text-muted-foreground">{group.actorCount} actors</span>
      {group.burst !== null ? <StatusPill status="attention" label={burstPillCopy(group.burst.count, group.burst.startedAt, group.burst.endedAt)} /> : null}
      <span className="ml-auto shrink-0 text-meta text-muted-foreground">{relativeOrDash(group.lastSeen, now)}</span>
    </div>
  )
}

function ActorRow({ group, now, selected, onSelect }: { readonly group: ActorGroup; readonly now: Date; readonly selected: boolean; readonly onSelect: () => void }) {
  const pill = actorAttributionPill(group.actor, group.attribution)
  return (
    <div
      data-slot="denial-actor-row"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={`flex h-9 cursor-pointer items-center gap-3 px-4 text-small outline-none ${selected ? 'bg-selection ring-2 ring-ring ring-inset' : ''}`}
    >
      <span className="w-48 shrink-0 truncate font-mono text-foreground">{group.key}</span>
      {pill !== null ? <StatusPill status={pill.tone} label={pill.label} /> : null}
      <span className="shrink-0 text-meta text-muted-foreground">
        {group.counts.deny} denied · {group.counts.miss} missed
      </span>
      <span className="shrink-0 text-meta text-muted-foreground">{group.shapeCount} commands</span>
      <span className="ml-auto shrink-0 text-meta text-muted-foreground">{relativeOrDash(group.lastSeen, now)}</span>
    </div>
  )
}

function CountBreakdown({ counts }: { readonly counts: ShapeGroup['counts'] }) {
  return (
    <p className="text-small text-muted-foreground">
      {counts.deny} deny · {counts.miss} miss · {counts.gateClear} gate-clear · {counts.hookError} hook-error · {counts.undecided} undecided
    </p>
  )
}

function ShapeDetailPane({ group, onClose }: { readonly group: ShapeGroup; readonly onClose: () => void }) {
  return (
    <DetailPane onClose={onClose}>
      <h2 className="break-all font-mono text-title font-semibold text-foreground">{group.shape}</h2>
      <p className="text-small text-muted-foreground">
        First seen {absoluteOrDash(group.firstSeen)} · Last seen {absoluteOrDash(group.lastSeen)}
      </p>
      <CountBreakdown counts={group.counts} />
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-meta text-foreground">{group.sample}</pre>
      {group.burst !== null ? (
        <p className="text-small text-attention-dot">
          Burst window: {absoluteOrDash(group.burst.startedAt)} – {absoluteOrDash(group.burst.endedAt)}
        </p>
      ) : null}
    </DetailPane>
  )
}

function ActorDetailPane({ group, onClose }: { readonly group: ActorGroup; readonly onClose: () => void }) {
  return (
    <DetailPane onClose={onClose}>
      <h2 className="break-all font-mono text-title font-semibold text-foreground">{group.key}</h2>
      <p className="text-small text-muted-foreground">
        First seen {absoluteOrDash(group.firstSeen)} · Last seen {absoluteOrDash(group.lastSeen)}
      </p>
      <CountBreakdown counts={group.counts} />
      {group.attribution?.kind === 'attributed' ? (
        <p className="text-small text-muted-foreground">
          {group.attribution.label ?? group.attribution.role} · last active {absoluteOrDash(group.attribution.lastActivityAt)}
        </p>
      ) : null}
    </DetailPane>
  )
}

export function DenialsTab({ repoId, group, onGroupChange }: { readonly repoId: RepoId; readonly group: DenialsGroup; readonly onGroupChange: (next: DenialsGroup) => void }) {
  const query = useIpcQuery('board:snapshot')
  const now = new Date()

  if (query.data === undefined) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  const repo = query.data.state.repositories.find((r) => r.ok && r.repoId === repoId)
  if (repo === undefined || !repo.ok) return null

  const inspection = inspectDenials({ read: repo.denials, sessions: query.data.state.sessions })

  if (!inspection.ok) {
    return (
      <div className="p-4">
        <ErrorBanner message={readFailedCopy(inspection.path, inspection.message)} />
      </div>
    )
  }

  if (!inspection.present) {
    return <EmptyState icon={ShieldAlert} message={emptyLogCopy()} className="p-6" />
  }

  if (inspection.analysed === 0) {
    return <EmptyState icon={ShieldAlert} message={noEntriesCopy()} className="p-6" />
  }

  return <DenialsInspector group={group} onGroupChange={onGroupChange} inspection={inspection} now={now} />
}

function DenialsInspector({
  group,
  onGroupChange,
  inspection,
  now,
}: {
  readonly group: DenialsGroup
  readonly onGroupChange: (next: DenialsGroup) => void
  readonly inspection: Extract<ReturnType<typeof inspectDenials>, { ok: true; present: true }>
  readonly now: Date
}) {
  const [selectedShape, setSelectedShape] = useState<string | null>(null)
  const [selectedActor, setSelectedActor] = useState<string | null>(null)
  const attributionLine = attributionLineCopy(inspection.attribution)
  const selectedShapeGroup = selectedShape !== null ? (inspection.byShape.find((s) => s.shape === selectedShape) ?? null) : null
  const selectedActorGroup = selectedActor !== null ? (inspection.byActor.find((a) => a.key === selectedActor) ?? null) : null

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-small text-muted-foreground">
            <span>{metaStripCopy(inspection.window)}</span>
            <span className="text-meta">Checked {new Date(inspection.readAt).toLocaleTimeString()}</span>
          </div>
          {inspection.capped ? <p className="text-meta text-muted-foreground">{cappedLineCopy(inspection.analysed, inspection.summary)}</p> : null}
          {attributionLine !== null ? <p className="text-small text-attention-dot">{attributionLine}</p> : null}
          <Tabs value={group} onValueChange={(value) => onGroupChange(value as DenialsGroup)}>
            <TabsList>
              <TabsTrigger value="command">By command</TabsTrigger>
              <TabsTrigger value="actor">By actor</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {group === 'command'
          ? inspection.byShape.map((shapeGroup) => (
              <ShapeRow key={shapeGroup.shape} group={shapeGroup} now={now} selected={shapeGroup.shape === selectedShape} onSelect={() => setSelectedShape(shapeGroup.shape)} />
            ))
          : inspection.byActor.map((actorGroup) => (
              <ActorRow key={actorGroup.key} group={actorGroup} now={now} selected={actorGroup.key === selectedActor} onSelect={() => setSelectedActor(actorGroup.key)} />
            ))}
      </div>
      {group === 'command' && selectedShapeGroup !== null ? <ShapeDetailPane group={selectedShapeGroup} onClose={() => setSelectedShape(null)} /> : null}
      {group === 'actor' && selectedActorGroup !== null ? <ActorDetailPane group={selectedActorGroup} onClose={() => setSelectedActor(null)} /> : null}
    </div>
  )
}
