// The Set up port checklist — three steps, each reusing `setupModel`'s own
// display state. Checks never re-run on their own; every re-check is a button.
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Page } from '@/renderer/components/page'
import { StatusPill } from '@/renderer/components/status-pill'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { useAction } from '@/renderer/actions/use-action'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { setupModel } from '@/renderer/setup/model'
import {
  CLAUDE_STEP_LABEL,
  FINISH_STEPS_FIRST,
  GH_STEP_LABEL,
  OPEN_BOARD,
  PENDING_LABEL,
  PROBE_UNREACHABLE,
  REPO_STEP_LABEL,
  SETUP_INTRO,
  SETUP_TITLE,
  SETUP_UNREACHABLE,
  SKIP_FOR_NOW,
} from '@/renderer/setup/copy'
import type { SetupStep } from '@/types/setup'
import type { RuntimeProbe } from '@/types/runtime'

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
      <p className="text-small text-foreground-secondary">
        {step.body}
        {step.bodyCommand !== null ? <span className="font-mono">{step.bodyCommand}</span> : null}
        {step.bodySuffix}
      </p>
      {step.detail !== null ? <p className="font-mono text-small text-muted-foreground">{step.detail}</p> : null}
      {step.action !== null ? (
        <Button variant="secondary" size="small" className="w-fit" disabled={pending} onClick={onAction}>
          {pending ? (
            <>
              <Loader2 aria-hidden="true" className="animate-spin" />
              {PENDING_LABEL[step.action.kind]}
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
  const preflightQuery = useIpcQuery('runtime.preflight')
  const ghQuery = useIpcQuery('gh.status')
  const reposQuery = useIpcQuery('repos.list')
  const probeAction = useAction('runtime.probe')
  const addRepo = useActionMutation('repos.add', { invalidates: ['repos.list'] })
  const [probe, setProbe] = useState<RuntimeProbe | null>(null)
  const [probeError, setProbeError] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)

  const anyErrored = preflightQuery.status === 'error' || ghQuery.status === 'error' || reposQuery.status === 'error'
  const model = setupModel(preflightQuery, probe, ghQuery, reposQuery)

  async function testSignIn(): Promise<void> {
    setProbeError(false)
    try {
      const readyRepo = reposQuery.data?.ok === true ? reposQuery.data.repositories.find((entry) => 'config' in entry) : undefined
      setProbe(await probeAction.run({ repoId: readyRepo !== undefined ? readyRepo.id : null }))
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
    const result = await addRepo.perform(undefined)
    if (result !== 'unreachable' && !result.ok) setRepoError(result.message)
  }

  return (
    <Page variant="form" header={<ScreenHeader>{SETUP_TITLE}</ScreenHeader>}>
      <p className="text-small text-foreground-secondary">{SETUP_INTRO}</p>
      {anyErrored ? <ErrorBanner message={SETUP_UNREACHABLE} /> : null}
      <div className="flex flex-col divide-y divide-border">
        <StepRow
          label={CLAUDE_STEP_LABEL}
          step={model.claude}
          loading={model.claude.state === 'loading'}
          pending={probeAction.pending}
          onAction={() => void (model.claude.action?.kind === 'test' ? testSignIn() : checkClaudeAgain())}
        />
        {model.claudeApiKeyNote !== null ? <p className="text-small text-muted-foreground">{model.claudeApiKeyNote}</p> : null}
        {probeError ? <ErrorBanner message={PROBE_UNREACHABLE} /> : null}
        <StepRow label={GH_STEP_LABEL} step={model.gh} loading={model.gh.state === 'loading'} pending={ghQuery.isFetching} onAction={() => void ghQuery.refetch()} />
        <StepRow label={REPO_STEP_LABEL} step={model.repo} loading={model.repo.state === 'loading'} pending={addRepo.pending} onAction={() => void addRepository()} />
        {repoError !== null ? <ErrorBanner message={repoError} /> : null}
      </div>
      <div className="flex items-center gap-2 pt-2">
        {model.complete ? (
          <Button onClick={() => void navigate({ to: ROUTE_IDS.board })}>{OPEN_BOARD}</Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <Button disabled tabIndex={-1}>
                  {OPEN_BOARD}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{FINISH_STEPS_FIRST}</TooltipContent>
          </Tooltip>
        )}
        <Button variant="ghost" onClick={() => void navigate({ to: ROUTE_IDS.board })}>
          {SKIP_FOR_NOW}
        </Button>
      </div>
    </Page>
  )
}
