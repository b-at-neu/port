// The one `gh run rerun` caller: re-runs only the failed jobs of one Actions run, audited once per attempt. Never cancels, deletes or re-runs a run that passed.
import { describe } from '@/main/github/release'
import type { GitHubWriteContext } from '@/main/github/context'
import { appendAudit } from '@/main/github/writes/audit'
import type { RerunAuditEntry, RerunContext } from '@/types/writes'

type RerunResult = { readonly kind: 'applied' } | { readonly kind: 'write-failed'; readonly message: string }

export async function rerunFailedJobs(ctx: GitHubWriteContext, request: RerunContext, params: { readonly number: number; readonly runId: string; readonly check: string }): Promise<RerunResult> {
  const argv = ['run', 'rerun', params.runId, '--failed', '--repo', request.repo]
  const result = await ctx.ghWrite(argv)
  const failure = result.ok ? null : describe(result)
  const entry: RerunAuditEntry = {
    at: ctx.clock.now().toISOString(),
    repo: request.repo,
    repoId: request.repoId,
    action: 'observe-rerun-checks',
    number: params.number,
    check: params.check,
    runId: params.runId,
    call: argv,
    result: failure === null ? 'applied' : 'failed',
    failure,
  }
  await appendAudit(request.auditDir, entry)
  return failure === null ? { kind: 'applied' } : { kind: 'write-failed', message: failure }
}
