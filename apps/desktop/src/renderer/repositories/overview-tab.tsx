// The repo page's Overview tab — Sources, Labels, Config, then Overrides and Warnings.
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { PageStates } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { StatusPill } from '@/renderer/components/status-pill'
import type { PillStatus } from '@/types/components'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { sourceHealthCopy, rateLimitCopy } from '@/renderer/board/copy'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { VocabularyVerdict } from '@/utils/labels/vocabulary'
import { overviewHealth } from '@/renderer/repositories/health-model'
import { diagnosticCopy, labelSourceCopy, moduleFlagCopy, NOT_READ_YET, overrideLineCopy, problemCopy, REPO_INVOKE_ERROR, summaryParts, verdictCopy, vocabularyProblemCopy } from '@/renderer/repositories/copy'

const VERDICT_STATUS: Readonly<Record<VocabularyVerdict, PillStatus>> = {
  verified: 'success',
  partial: 'attention',
  'mis-resolved': 'attention',
  unverified: 'idle',
}

export function OverviewTab({ entry, repoId }: { readonly entry: RepositoryEntry; readonly repoId: RepoId }) {
  const queryClient = useQueryClient()
  const snapshotQuery = useIpcQuery('board.snapshot')
  const refresh = useActionMutation('board.refresh', {
    onResult: (fresh) => queryClient.setQueryData(ipcQueryOptions('board.snapshot').queryKey, fresh),
  })

  if (!('config' in entry)) {
    return <ErrorBanner message={problemCopy(entry.problem)} className="m-4" />
  }

  const { config } = entry
  const branches = summaryParts(config)[0] ?? ''

  const health = overviewHealth(config, repoId, snapshotQuery.data)
  const now = new Date()

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-small font-medium text-foreground">Sources</h3>
          <Button variant="ghost" size="small" onClick={() => refresh.request({ repoId })} disabled={refresh.pending}>
            Refresh all
          </Button>
        </div>
        <PageStates
          loading={
            <div className="flex flex-col gap-1">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          }
          state={pageState({ data: snapshotQuery.data, status: snapshotQuery.status }, () => health.sources === null)}
          errorMessage={REPO_INVOKE_ERROR}
          onRetry={() => void snapshotQuery.refetch()}
          empty={<p className="text-small text-muted-foreground">{NOT_READ_YET}</p>}
        >
          <div className="flex flex-col gap-1">
            {(health.sources ?? []).map((source) => (
              <div key={source.kind} className="flex items-center justify-between gap-2 text-small">
                <span className={source.health.consecutiveFailures > 0 ? 'text-attention-dot' : 'text-foreground'}>
                  {sourceHealthCopy(source.kind, source.health, now)}
                  {source.kind === 'github' && health.rateLimit !== null ? ` — ${rateLimitCopy(null, health.rateLimit.remaining, health.rateLimit.resetAt) ?? ''}` : ''}
                </span>
                <Button variant="ghost" size="small" onClick={() => refresh.request({ repoId, source: source.kind })} disabled={refresh.pending}>
                  Refresh
                </Button>
              </div>
            ))}
          </div>
        </PageStates>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-small font-medium text-foreground">Labels</h3>
        {health.labels === null ? (
          <p className="text-small text-muted-foreground">{NOT_READ_YET}</p>
        ) : (
          <>
            <div data-slot="label-verdict">
              <StatusPill
                status={VERDICT_STATUS[health.labels.verdict]}
                label={verdictCopy(health.labels.verdict, health.labels.rows.length, health.labels.rows.length - health.labels.rows.filter((r) => r.present === true).length, health.labels.unverifiedReason, health.labels.appOnly)}
              />
            </div>
            {health.labels.problems.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {health.labels.problems.map((problem, index) => (
                  <p key={index} className="text-small text-attention-dot">
                    {vocabularyProblemCopy(problem)}
                  </p>
                ))}
              </div>
            ) : null}
            <table className="w-full text-small">
              <tbody>
                {health.labels.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="py-0.5 pr-3 font-mono text-foreground">{row.name}</td>
                    <td className="py-0.5 pr-3 text-foreground">{row.roleDisplay}</td>
                    <td className="py-0.5 pr-3 text-meta text-muted-foreground">{labelSourceCopy(row.source)}</td>
                    <td className="py-0.5 text-meta">{row.present === null ? '—' : row.present ? 'Present' : 'Missing'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-small font-medium text-foreground">Config</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
          <dt className="text-muted-foreground">Branches</dt>
          <dd className="text-foreground">{branches}</dd>
          <dt className="text-muted-foreground">Path</dt>
          <dd className="font-mono text-foreground">{entry.path}</dd>
          <dt className="text-muted-foreground">Modules</dt>
          <dd className="text-foreground">{moduleFlagCopy(health.modules)}</dd>
        </dl>
      </section>

      {config.overrides.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium text-foreground">Overrides in effect</h3>
          {config.overrides.map((override) => (
            <p key={override.path ?? override.reason} className="font-mono text-meta text-muted-foreground">
              {overrideLineCopy(override)}
            </p>
          ))}
        </div>
      ) : null}

      {entry.diagnostics.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium text-foreground">Warnings</h3>
          {entry.diagnostics.map((diagnostic, index) => (
            <p key={index} className="text-small text-attention-dot">
              {diagnosticCopy(diagnostic)}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
