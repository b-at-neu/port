// The Settings screen's Claude Code status. Reads `runtime:preflight` as a query and runs
// `runtime:probe` through `useAction`; `runtime-model.ts` decides everything about what to show,
// this component only renders it. No `useEffect`.
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { formatAgoSince } from '@/renderer/lib/time'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useAction } from '@/renderer/actions/use-action'
import { useIpcQuery } from '@/renderer/data/query'
import { StatusPill } from '@/renderer/components/status-pill'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { cardCheckError, checkedAgoLine, CLAUDE_CODE_SUBJECT, CLAUDE_CODE_TITLE, TESTING_LABEL } from '@/renderer/settings/copy'
import { QueryCard } from '@/renderer/settings/query-card'
import { runtimeDiagnosisModel } from '@/renderer/settings/runtime-model'
import type { ReadyRepo } from '@/types/repositories'
import type { ReposListResponse } from '@/types/ipc'
import type { RuntimeProbe } from '@/types/runtime'

function firstReadyRepo(result: ReposListResponse | undefined): ReadyRepo | null {
  if (result === undefined || !result.ok) return null
  for (const entry of result.repositories) {
    if ('config' in entry) return { id: entry.id, repo: entry.config.repo }
  }
  return null
}

export function RuntimeSection() {
  const preflightQuery = useIpcQuery('runtime.preflight')
  const reposQuery = useIpcQuery('repos.list')
  const probeAction = useAction('runtime.probe')
  const [probe, setProbe] = useState<RuntimeProbe | null>(null)
  const [probeError, setProbeError] = useState(false)
  const readyRepo = firstReadyRepo(reposQuery.data)

  // Mirrors the runtime strip's own `handleAction` exactly: a ready
  // repository always runs a real probe turn, whatever the button's own
  // label says; with none registered, every action re-runs the cheap
  // preflight instead.
  async function runAction(): Promise<void> {
    setProbeError(false)
    if (readyRepo !== null) {
      try {
        setProbe(await probeAction.run({ repoId: readyRepo.id }))
      } catch {
        setProbeError(true)
      }
      return
    }
    await preflightQuery.refetch()
  }

  return (
    <QueryCard
      title={CLAUDE_CODE_TITLE}
      query={preflightQuery}
      errorMessage={cardCheckError(CLAUDE_CODE_SUBJECT)}
      loading={
        <>
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-4 w-56" />
        </>
      }
    >
      {(preflight) => {
        const model = runtimeDiagnosisModel(preflight, probe, readyRepo, probeError, reposQuery.status === 'pending')
        const checkedAt = probe?.checkedAt ?? preflight.checkedAt
        return (
          <>
            <StatusPill status={model.pillStatus} label={model.pillLabel} />
            {model.versionLine !== null ? <p className="font-mono text-small text-muted-foreground">{model.versionLine}</p> : null}
            <div>
              <p className="text-body text-foreground">{model.title}</p>
              <p className="text-small text-foreground-secondary">{model.body}</p>
              {model.detail !== null ? <p className="font-mono text-small text-muted-foreground">{model.detail}</p> : null}
            </div>
            {model.notes.map((note) => (
              <p key={note} className="text-small text-muted-foreground">
                {note}
              </p>
            ))}
            <p className="text-small text-muted-foreground">{checkedAgoLine(formatAgoSince(checkedAt, new Date()))}</p>
            {model.probeErrorMessage !== null ? <ErrorBanner message={model.probeErrorMessage} /> : null}
            {model.action !== null ? (
              model.action.disabledReason !== null ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="inline-flex w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                      <Button disabled tabIndex={-1}>
                        {model.action.label}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{model.action.disabledReason}</TooltipContent>
                </Tooltip>
              ) : (
                <Button disabled={probeAction.pending} onClick={() => void runAction()}>
                  {probeAction.pending ? (
                    <>
                      <Loader2 aria-hidden="true" className="animate-spin" />
                      {TESTING_LABEL}
                    </>
                  ) : (
                    model.action.label
                  )}
                </Button>
              )
            ) : null}
          </>
        )
      }}
    </QueryCard>
  )
}
