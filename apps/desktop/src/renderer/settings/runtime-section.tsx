// The Settings screen's Claude Code status (#316) — the first slice of
// #318's Settings screen, since the theme control needs a home and this is
// it. Reads `runtime:preflight` as a query and runs `runtime:probe` as a
// mutation; `runtime-model.ts` decides everything about what to show, this
// component only renders it. No `useEffect`: data arrives through
// `useIpcQuery`/`useIpcMutation` alone.
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { SettingsCard } from '@/renderer/components/settings-card'
import { formatAgo } from '@/renderer/lib/relative-time'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useIpcMutation, useIpcQuery } from '@/renderer/data/query'
import { StatusPill } from '@/renderer/components/status-pill'
import { ErrorBanner } from '@/renderer/components/error-banner'
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
  const preflightQuery = useIpcQuery('runtime:preflight')
  const reposQuery = useIpcQuery('repos:list')
  const probeMutation = useIpcMutation('runtime:probe')
  const [probe, setProbe] = useState<RuntimeProbe | null>(null)
  const [probeError, setProbeError] = useState(false)

  if (preflightQuery.status === 'pending') {
    return (
      <SettingsCard title="Claude Code">
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-56" />
      </SettingsCard>
    )
  }

  if (preflightQuery.status === 'error') {
    return (
      <SettingsCard title="Claude Code">
        <ErrorBanner message="Couldn't reach the main process to check Claude Code. Restart port to try again." />
      </SettingsCard>
    )
  }

  const readyRepo = firstReadyRepo(reposQuery.data)
  const model = runtimeDiagnosisModel(preflightQuery.data, probe, readyRepo, probeError, reposQuery.status === 'pending')

  // Mirrors the runtime strip's own `handleAction` exactly: a ready
  // repository always runs a real probe turn, whatever the button's own
  // label says; with none registered, every action re-runs the cheap
  // preflight instead.
  async function runAction(): Promise<void> {
    setProbeError(false)
    if (readyRepo !== null) {
      try {
        const result = await probeMutation.mutateAsync({ repoId: readyRepo.id })
        setProbe(result)
      } catch {
        setProbeError(true)
      }
      return
    }
    await preflightQuery.refetch()
  }

  const checkedAt = probe?.checkedAt ?? preflightQuery.data.checkedAt

  return (
    <SettingsCard title="Claude Code">
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
      <p className="text-small text-muted-foreground">Checked {formatAgo(new Date().getTime() - Date.parse(checkedAt))}</p>
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
          <Button disabled={probeMutation.isPending} onClick={() => void runAction()}>
            {probeMutation.isPending ? (
              <>
                <Loader2 aria-hidden="true" className="animate-spin" />
                Testing…
              </>
            ) : (
              model.action.label
            )}
          </Button>
        )
      ) : null}
    </SettingsCard>
  )
}
