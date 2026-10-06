// The repo page's Denials tab (#85, #319, plan's own **UX states**) — the
// existing denial-burst line from `projectBoard`'s own `repositorySummaries`,
// never a line total (Decision 7).
import { ShieldAlert } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '../components/empty-state'
import { useIpcQuery } from '../data/query'
import { projectBoard } from '../../../shared/board/project'
import type { RepoId } from '../../../shared/repos'

export function DenialsTab({ repoId }: { readonly repoId: RepoId }) {
  const query = useIpcQuery('board:snapshot')

  if (query.data === undefined) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-5 w-full" />
      </div>
    )
  }

  const projection = projectBoard({ snapshot: query.data, groupBy: 'repo', now: new Date() })
  const burst = projection.repositorySummaries.find((summary) => summary.repoId === repoId)?.denialBurst ?? null

  if (burst === null) {
    return <EmptyState icon={ShieldAlert} message="No denial bursts in this repository's log." className="p-6" />
  }

  return (
    <div className="p-4">
      <p className="rounded-md bg-attention-pill px-3 py-2 text-small text-attention-pill-foreground">{burst}</p>
    </div>
  )
}
