// The idle upcoming section: a count bar with Cut release over a flat, newest-first list of the PRs merged since the last release.
import { useState } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { LabelChip } from '@/renderer/components/label-chip'
import { exactTime, relativeAge } from '@/renderer/backlog/group'
import type { ReleaseEntry, ReleaseStatus } from '@/types/release'
import { CUT_RELEASE, mergedSinceCopy, showMoreIssues } from '@/renderer/releases/copy'
import { visibleIssues } from '@/renderer/releases/model'

const MAX_CHIPS = 3

function PrRow({ entry, now }: { readonly entry: ReleaseEntry; readonly now: Date }) {
  return (
    <div data-slot="merged-pr-row" className="flex h-9 items-center gap-2 px-4 text-body">
      <a href={entry.url} target="_blank" rel="noreferrer" aria-label={`#${String(entry.number)} ${entry.title}`} className="shrink-0 rounded-sm font-mono tabular-nums text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        #{entry.number}
      </a>
      <span className="min-w-24 flex-1 truncate text-foreground">{entry.title}</span>
      <div className="flex min-w-0 max-w-48 shrink gap-1">
        {entry.labels.slice(0, MAX_CHIPS).map((label) => (
          <LabelChip key={label.name} label={label} />
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="w-10 shrink-0 text-right text-meta text-muted-foreground">{relativeAge(entry.mergedAt, now)}</span>
        </TooltipTrigger>
        <TooltipContent>{exactTime(entry.mergedAt)}</TooltipContent>
      </Tooltip>
    </div>
  )
}

interface MergedPrsProps {
  readonly status: ReleaseStatus
  readonly pending: boolean
  readonly onCut: () => void
  readonly now: Date
}

export function MergedPrs({ status, pending, onCut, now }: MergedPrsProps) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden } = visibleIssues(status.entries, expanded)
  return (
    <div data-slot="release-upcoming">
      <div data-slot="merged-prs-bar" className="flex h-9 items-center justify-between bg-muted/50 px-4 text-body font-medium text-foreground">
        <span>{mergedSinceCopy(status.entries.length, status.sinceTag)}</span>
        <Button size="small" disabled={pending} onClick={onCut}>
          {CUT_RELEASE}
        </Button>
      </div>
      {status.truncatedNote !== null ? <p className="px-4 py-1 text-meta text-muted-foreground">{status.truncatedNote}</p> : null}
      {shown.map((entry) => (
        <PrRow key={entry.number} entry={entry} now={now} />
      ))}
      {hidden > 0 ? (
        <Button variant="ghost" size="small" className="ml-4" onClick={() => setExpanded(true)}>
          {showMoreIssues(hidden)}
        </Button>
      ) : null}
    </div>
  )
}
