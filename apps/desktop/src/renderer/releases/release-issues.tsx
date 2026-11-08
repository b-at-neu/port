// The "Tickets included" section of a previous release's pane — four states over one lazily fetched `release:issues` read.
import { useState } from 'react'
import { CircleDot } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { LabelChip } from '@/renderer/components/label-chip'
import { useIpcQuery } from '@/renderer/data/query'
import type { ReleaseInfo, ReleaseIssue } from '@/types/release'
import type { RepoId } from '@/utils/repos'
import { TRY_AGAIN, ISSUES_EMPTY, issuesFailureCopy, issuesHeading, showMoreIssues } from '@/renderer/releases/copy'
import { visibleIssues } from '@/renderer/releases/model'

const MAX_CHIPS = 3
const ROW_CLASS = 'flex h-9 items-center gap-2 rounded-md px-2 text-body outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

function IssueRow({ issue }: { readonly issue: ReleaseIssue }) {
  return (
    <a data-slot="release-issue-row" href={issue.url} target="_blank" rel="noreferrer" aria-label={`#${String(issue.number)} ${issue.title}`} className={ROW_CLASS}>
      <span className="shrink-0 font-mono tabular-nums text-muted-foreground">#{issue.number}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{issue.title}</span>
      <div className="flex min-w-0 shrink gap-1">
        {issue.labels.slice(0, MAX_CHIPS).map((label) => (
          <LabelChip key={label.name} label={label} />
        ))}
      </div>
    </a>
  )
}

function Heading({ count }: { readonly count: number | null }) {
  return <p className="text-meta font-medium text-muted-foreground">{issuesHeading(count)}</p>
}

export function ReleaseIssues({ repoId, release }: { readonly repoId: RepoId; readonly release: ReleaseInfo }) {
  const query = useIpcQuery('release:issues', { repoId, tag: release.tagName, previousTag: release.previousTag })
  const [expanded, setExpanded] = useState(false)
  const data = query.data

  if (query.isError || data?.ok === false) {
    const message = data?.ok === false ? data.message : (query.error?.message ?? 'the read was rejected')
    return (
      <section data-slot="release-issues" className="flex flex-col gap-2">
        <Heading count={null} />
        <ErrorBanner message={issuesFailureCopy(message)} action={{ label: TRY_AGAIN, onClick: () => void query.refetch() }} />
      </section>
    )
  }
  if (data === undefined) {
    return (
      <section data-slot="release-issues" className="flex flex-col gap-2">
        <Heading count={null} />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </section>
    )
  }

  const { shown, hidden } = visibleIssues(data.issues, expanded)
  return (
    <section data-slot="release-issues" className="flex flex-col gap-1">
      <Heading count={data.issues.length} />
      {data.note === null ? null : <p className="text-meta text-muted-foreground">{data.note}</p>}
      {data.issues.length === 0 ? <EmptyState icon={CircleDot} message={ISSUES_EMPTY} data-slot="release-issues-empty" /> : shown.map((issue) => <IssueRow key={issue.number} issue={issue} />)}
      {hidden > 0 ? (
        <Button variant="ghost" size="small" className="self-start" onClick={() => setExpanded(true)}>
          {showMoreIssues(hidden)}
        </Button>
      ) : null}
    </section>
  )
}
