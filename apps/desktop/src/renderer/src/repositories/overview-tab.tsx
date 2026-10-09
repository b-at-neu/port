// The repo page's Overview tab — Sources, Labels, Config, then Overrides and Warnings.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorBanner } from '../components/error-banner'
import { StatusPill } from '../components/status-pill'
import type { PillStatus } from '../components/status-pill'
import { ipcQueryOptions, useIpcQuery } from '../data/query'
import { invoke } from '../data/invoke'
import { sourceHealthCopy, rateLimitCopy } from '../board/copy'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { VocabularyVerdict } from '../../../shared/labels/vocabulary'
import { overviewHealth } from './health-model'
import { diagnosticCopy, labelSourceCopy, moduleFlagCopy, overrideLineCopy, problemCopy, summaryParts, verdictCopy, vocabularyProblemCopy } from './copy'

const VERDICT_STATUS: Readonly<Record<VocabularyVerdict, PillStatus>> = {
  verified: 'success',
  partial: 'attention',
  'mis-resolved': 'attention',
  unverified: 'idle',
}

export function OverviewTab({ entry, repoId }: { readonly entry: RepositoryEntry; readonly repoId: RepoId }) {
  const queryClient = useQueryClient()
  const snapshotQuery = useIpcQuery('board:snapshot')
  const [pending, setPending] = useState<string | null>(null)

  if (!('config' in entry)) {
    return <ErrorBanner message={problemCopy(entry.problem)} className="m-4" />
  }

  const { config } = entry
  const branches = summaryParts(config)[0] ?? ''

  async function refresh(source?: 'github' | 'sessions' | 'worktrees' | 'denials'): Promise<void> {
    setPending(source ?? 'all')
    try {
      const fresh = await invoke('board:refresh', { repoId, source })
      queryClient.setQueryData(ipcQueryOptions('board:snapshot').queryKey, fresh)
    } catch (error) {
      console.error('Failed to refresh this repository', error)
    }
    setPending(null)
  }

  const now = new Date()
  const health = overviewHealth(config, repoId, snapshotQuery.data, now)

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-small font-medium text-foreground">Sources</h3>
          <Button variant="ghost" size="small" onClick={() => void refresh()} disabled={pending !== null}>
            Refresh all
          </Button>
        </div>
        {snapshotQuery.isLoading ? (
          <div className="flex flex-col gap-1">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : health.sources === null ? (
          <p className="text-small text-muted-foreground">Not read yet. port reads it on the next poll.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {health.sources.map((source) => (
              <div key={source.kind} className="flex items-center justify-between gap-2 text-small">
                <span className={source.health.consecutiveFailures > 0 ? 'text-attention-dot' : 'text-foreground'}>
                  {sourceHealthCopy(source.kind, source.health, now)}
                  {source.kind === 'github' && health.rateLimit !== null ? ` — ${rateLimitCopy(null, health.rateLimit.remaining, health.rateLimit.resetAt) ?? ''}` : ''}
                </span>
                <Button variant="ghost" size="small" onClick={() => void refresh(source.kind)} disabled={pending !== null}>
                  Refresh
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-small font-medium text-foreground">Labels</h3>
        {health.labels === null ? (
          <p className="text-small text-muted-foreground">Not read yet. port reads it on the next poll.</p>
        ) : (
          <>
            <div data-slot="label-verdict">
              <StatusPill
                status={VERDICT_STATUS[health.labels.verdict]}
                label={verdictCopy(health.labels.verdict, health.labels.rows.length, health.labels.rows.length - health.labels.rows.filter((r) => r.present === true).length, health.labels.unverifiedReason)}
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
