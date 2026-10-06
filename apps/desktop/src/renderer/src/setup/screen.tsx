// The Set up port checklist — three steps, each reusing `setupModel`'s own
// display state. Checks never re-run on their own; every re-check is a button.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ScreenHeader } from '../components/screen-header'
import { StatusPill } from '../components/status-pill'
import { ErrorBanner } from '../components/error-banner'
import { ipcQueryOptions, useIpcMutation, useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/legacy-view'
import { setupModel } from './model'
import type { SetupStep } from './model'
import type { RuntimeProbe } from '../../../shared/runtime/types'
import type { ReposListResponse } from '../../../shared/ipc'

function StepRow({ label, step, loading, pending, onAction }: { readonly label: string; readonly step: SetupStep; readonly loading: boolean; readonly pending: boolean; readonly onAction: () => void }) {
  if (loading) {
    return (
      <div data-step className="flex flex-col gap-2 py-3">
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-56" />
      </div>
    )
  }

  return (
    <div data-step className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-body text-foreground">{label}</p>
        <StatusPill status={step.pillStatus} label={step.pillLabel} />
      </div>
      <p className="text-small text-foreground-secondary">{step.body}</p>
      {step.detail !== null ? <p className="font-mono text-small text-muted-foreground">{step.detail}</p> : null}
      {step.action !== null ? (
        <Button variant="secondary" size="small" className="w-fit" disabled={pending} onClick={onAction}>
          {pending ? (
            <>
              <Loader2 aria-hidden="true" className="animate-spin" />
              Testing…
            </>
          ) : (
            step.action.label
          )}
        </Button>
      ) : null}
    </div>
  )
}

export function SetupScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const preflightQuery = useIpcQuery('runtime:preflight')
  const ghQuery = useIpcQuery('gh:status')
  const reposQuery = useIpcQuery('repos:list')
  const probeMutation = useIpcMutation('runtime:probe')
  const addRepoMutation = useIpcMutation('repos:add')
  const [probe, setProbe] = useState<RuntimeProbe | null>(null)
  const [probeError, setProbeError] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)

  const anyErrored = preflightQuery.status === 'error' || ghQuery.status === 'error' || reposQuery.status === 'error'
  const model = setupModel(preflightQuery, probe, ghQuery, reposQuery)

  async function testSignIn(): Promise<void> {
    setProbeError(false)
    try {
      const readyRepo = reposQuery.data?.ok === true ? reposQuery.data.repositories.find((entry) => 'config' in entry) : undefined
      const result = await probeMutation.mutateAsync({ repoId: readyRepo !== undefined ? readyRepo.id : null })
      setProbe(result)
    } catch {
      setProbeError(true)
    }
  }

  async function checkClaudeAgain(): Promise<void> {
    await preflightQuery.refetch()
    if (probe !== null) await testSignIn()
  }

  async function addRepository(): Promise<void> {
    setRepoError(null)
    try {
      const result = await addRepoMutation.mutateAsync(undefined)
      if (result.ok && (result.outcome === 'added' || result.outcome === 'already-registered')) {
        const repositories = result.repositories
        queryClient.setQueryData(ipcQueryOptions('repos:list').queryKey, (): ReposListResponse => ({ ok: true, repositories }))
      } else if (!result.ok) {
        setRepoError(result.message)
      }
    } catch {
      setRepoError("Couldn't reach the main process to add a repository.")
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader>Set up port</ScreenHeader>
      <div className="flex max-w-md flex-col gap-4 p-4 text-left">
        <p className="text-small text-foreground-secondary">port runs your own installed Claude Code and gh under your own accounts. Finish these steps to start.</p>
        {anyErrored ? <ErrorBanner message="Couldn't reach the main process to check setup. Restart port to try again." /> : null}
        <div className="flex flex-col divide-y divide-border">
          <StepRow
            label="Claude Code installed and signed in"
            step={model.claude}
            loading={model.claude.state === 'loading'}
            pending={probeMutation.isPending}
            onAction={() => void (model.claude.action?.kind === 'test' ? testSignIn() : checkClaudeAgain())}
          />
          {model.claudeApiKeyNote !== null ? <p className="text-small text-muted-foreground">{model.claudeApiKeyNote}</p> : null}
          {probeError ? <ErrorBanner message="Couldn't reach the main process to test the connection." /> : null}
          <StepRow
            label="gh installed and signed in"
            step={model.gh}
            loading={model.gh.state === 'loading'}
            pending={ghQuery.isFetching}
            onAction={() => void ghQuery.refetch()}
          />
          <StepRow
            label="Add a repository"
            step={model.repo}
            loading={model.repo.state === 'loading'}
            pending={addRepoMutation.isPending}
            onAction={() => void addRepository()}
          />
          {repoError !== null ? <ErrorBanner message={repoError} /> : null}
        </div>
        <div className="flex items-center gap-2 pt-2">
          {model.complete ? (
            <Button onClick={() => void navigate({ to: ROUTE_IDS.board })}>Open board</Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <Button disabled tabIndex={-1}>
                    Open board
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Finish the steps above first.</TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" onClick={() => void navigate({ to: ROUTE_IDS.board })}>
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  )
}
