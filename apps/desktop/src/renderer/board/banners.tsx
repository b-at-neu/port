// The Board's own banners, below Waiting on you, in a fixed order: store
// error, Not reading, ownership, Ungated PRs.
import { ErrorBanner } from '@/renderer/components/error-banner'
import { TicketRow } from '@/renderer/components/ticket-row'
import { Button } from '@/renderer/components/ui/button'
import type { BoardItemRow, BoardProjection, BoardSnapshot } from '@/types/board'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { notReadyCopy } from '@/renderer/board/problem-copy'
import { takeOver } from '@/renderer/board/dispatch'
import { ownershipBannerFor } from '@/renderer/board/owner'
import { storeBannerCopy } from '@/renderer/board/tick'
import { useListSelection } from '@/renderer/shell/list-selection'

interface BoardBannersProps {
  readonly snapshot: BoardSnapshot
  readonly projection: BoardProjection
  // Already scoped to the selected repo, same as the main sections — see
  // `screen.tsx`.
  readonly ungated: readonly BoardItemRow[]
  readonly selection: ReturnType<typeof useListSelection>
}

function StoreBanner({ snapshot }: { readonly snapshot: BoardSnapshot }) {
  const message = storeBannerCopy(snapshot.runStates.store)
  if (message === null) return null
  return (
    <div className="px-4 pt-3">
      <ErrorBanner message={message} />
    </div>
  )
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

function OwnershipBanners({ snapshot }: { readonly snapshot: BoardSnapshot }) {
  const banners = snapshot.dispatch.flatMap((status) => {
    const repoName = snapshot.tick.find((report) => report.repoId === status.repoId)?.displayName ?? status.repoId
    const banner = ownershipBannerFor(status, repoName)
    return banner !== null ? [{ status, repoName, banner }] : []
  })
  if (banners.length === 0) return null
  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      {banners.map(({ status, repoName, banner }) =>
        banner.kind === 'error' ? (
          <ErrorBanner key={status.repoId} message={banner.message} />
        ) : (
          <div key={status.repoId} className="flex items-center gap-2 text-small text-foreground">
            <span>{banner.message}</span>
            {banner.takeOver ? (
              <Button variant="ghost" size="small" title="Only do this once the terminal has stopped — this app can't confirm that itself." onClick={() => void takeOver(status.repoId, repoName)}>
                Take over…
              </Button>
            ) : null}
          </div>
        ),
      )}
    </div>
  )
}

// Excluded from the main sections (`screen.tsx`), so this is each row's one
// mount — same `selection` and bare `data-row-key` a section row would use.
function UngatedBanner({ rows, selection }: { readonly rows: readonly BoardItemRow[]; readonly selection: ReturnType<typeof useListSelection> }) {
  if (rows.length === 0) return null
  const markerName = LABEL_DEFAULTS.find((def) => def.key === 'marker')?.name ?? 'marker'
  return (
    <div className="flex flex-col gap-1 px-4 pt-3">
      <div className="text-small font-medium text-foreground">Ungated pull requests · {rows.length}</div>
      <p className="text-meta text-muted-foreground">
        These carry a pipeline label but not &quot;{markerName}&quot;, so CI can&apos;t tell them from a human pull request and the merge gate is inactive.
      </p>
      <div>
        {rows.map((row) => (
          <TicketRow key={`${row.item.repoId}:${String(row.ticket.ref.number)}`} row={row} rowProps={selection.rowProps(`${row.item.repoId}:${String(row.ticket.ref.number)}`)} />
        ))}
      </div>
    </div>
  )
}

export function BoardBanners({ snapshot, projection, ungated, selection }: BoardBannersProps) {
  return (
    <>
      <StoreBanner snapshot={snapshot} />
      <NotReadingBanner projection={projection} />
      <OwnershipBanners snapshot={snapshot} />
      <UngatedBanner rows={ungated} selection={selection} />
    </>
  )
}
