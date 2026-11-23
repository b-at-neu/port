// The one `gh run rerun` caller: re-runs only the failed jobs of one Actions run, audited once per attempt. Never cancels, deletes or re-runs a run that passed.
import { describe } from '@/main/github/release'
import { gh as defaultGh } from '@/main/platform/gh'
import { appendAudit } from '@/main/github/writes/audit'
import type { RerunAuditEntry, RerunContext } from '@/types/writes'

type RerunResult = { readonly kind: 'applied' } | { readonly kind: 'write-failed'; readonly message: string }

export async function rerunFailedJobs(ctx: RerunContext, params: { readonly number: number; readonly runId: string; readonly check: string }): Promise<RerunResult> {
  const argv = ['run', 'rerun', params.runId, '--failed', '--repo', ctx.repo]
  const result = await (ctx.gh ?? defaultGh)(argv)
  const failure = result.ok ? null : describe(result)
  const entry: RerunAuditEntry = {
    at: (ctx.now ?? (() => new Date()))().toISOString(),
    repo: ctx.repo,
    repoId: ctx.repoId,
    action: 'observe-rerun-checks',
    number: params.number,
    check: params.check,
    runId: params.runId,
    call: argv,
    result: failure === null ? 'applied' : 'failed',
    failure,
  }
  await appendAudit(ctx.auditDir, entry)
  return failure === null ? { kind: 'applied' } : { kind: 'write-failed', message: failure }
}
