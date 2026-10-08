// The Board's own banners, above the list, in a fixed order: Not reading,
// Ungated PRs.
import { ErrorBanner } from '../components/error-banner'
import { TicketRow } from '../components/ticket-row'
import type { BoardItemRow, BoardProjection } from '../../../shared/board/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import { notReadyCopy } from './copy'

export interface BoardBannersProps {
  readonly projection: BoardProjection
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

export function BoardBanners({ projection, onSelectRow }: BoardBannersProps) {
  return (
    <>
      <NotReadingBanner projection={projection} />
      <UngatedBanner projection={projection} onSelectRow={onSelectRow} />
    </>
  )
}
