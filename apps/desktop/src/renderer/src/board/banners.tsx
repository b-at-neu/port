// The Board's own banners, above the list, in a fixed order: Not reading,
// Relay, Ungated PRs.
import { useState } from 'react'
import { ErrorBanner } from '../components/error-banner'
import { TicketRow } from '../components/ticket-row'
import type { BoardItemRow, BoardProjection } from '../../../shared/board/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import { needsYouLeadCopy } from '../needs-you/copy'
import type { NeedsYouItem } from '../../../shared/board/needs-you'
import { needsYouItems } from '../../../shared/board/needs-you'
import type { BoardSnapshot } from '../../../shared/board/types'
import { notReadyCopy } from './copy'
import { RelayCard } from './relay-card'

export interface BoardBannersProps {
  readonly snapshot: BoardSnapshot
  readonly projection: BoardProjection
  readonly now: Date
  readonly onSelectRow: (row: BoardItemRow) => void
}

function NotReadingBanner({ projection }: { readonly projection: BoardProjection }) {
  if (projection.notReady.length === 0) return null
  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      {projection.notReady.map((state) => {
        const name = 'repo' in state && state.repo !== undefined ? state.repo : state.displayName
        return <ErrorBanner key={state.repoId} message={`${name} — ${notReadyCopy(state)}`} />
      })}
    </div>
  )
}

function RelayBanner({ snapshot, now }: { readonly snapshot: BoardSnapshot; readonly now: Date }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const questions = needsYouItems(snapshot, now).filter((item): item is Extract<NeedsYouItem, { readonly kind: 'question' }> => item.kind === 'question')
  if (questions.length === 0) return null

  function keyOf(item: Extract<NeedsYouItem, { readonly kind: 'question' }>): string {
    return item.pending.sessionId
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-attention-pill px-3 py-2 text-attention-pill-foreground">
      <div className="text-small font-medium">
        {questions.length} question{questions.length === 1 ? '' : 's'} waiting on you
      </div>
      {questions.map((item) => {
        const key = keyOf(item)
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-small">
              <span>{needsYouLeadCopy(item)}</span>
              <button type="button" className="shrink-0 text-primary-text hover:underline" onClick={() => setExpanded(expanded === key ? null : key)}>
                Answer
              </button>
            </div>
            {expanded === key ? <RelayCard pending={item.pending} /> : null}
          </div>
        )
      })}
    </div>
  )
}

function UngatedBanner({ projection, onSelectRow }: { readonly projection: BoardProjection; readonly onSelectRow: (row: BoardItemRow) => void }) {
  if (projection.ungated.length === 0) return null
  const markerName = LABEL_DEFAULTS.find((def) => def.key === 'marker')?.name ?? 'marker'
  return (
    <div className="flex flex-col gap-1 px-4 pt-3">
      <div className="text-small font-medium text-foreground">Ungated pull requests · {projection.ungated.length}</div>
      <p className="text-meta text-muted-foreground">
        These carry a pipeline label but not &quot;{markerName}&quot;, so CI can&apos;t tell them from a human pull request and the merge gate is inactive.
      </p>
      <div>
        {projection.ungated.map((row) => (
          <TicketRow key={`${row.item.repoId}:${String(row.item.number)}`} row={row} selected={false} onSelect={() => onSelectRow(row)} />
        ))}
      </div>
    </div>
  )
}

export function BoardBanners({ snapshot, projection, now, onSelectRow }: BoardBannersProps) {
  return (
    <>
      <NotReadingBanner projection={projection} />
      <div className="px-4 pt-3">
        <RelayBanner snapshot={snapshot} now={now} />
      </div>
      <UngatedBanner projection={projection} onSelectRow={onSelectRow} />
    </>
  )
}
