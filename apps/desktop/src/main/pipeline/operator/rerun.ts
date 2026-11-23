// Re-runs the failed jobs of a held review's red Actions checks, one audited write per run.
import { rerunFailedJobs } from '@/main/github/writes/rerun'
import type { RerunChecksParams } from '@/types/actions'

export async function rerunChecks(params: RerunChecksParams): Promise<'applied' | 'failed'> {
  const { entry } = params
  let outcome: 'applied' | 'failed' = 'applied'
  for (const run of params.runs) {
    const result = await rerunFailedJobs({ repo: entry.config.repo, repoId: entry.id, auditDir: params.auditDir }, { number: params.number, runId: run.runId, check: run.check })
    if (result.kind !== 'applied') outcome = 'failed'
  }
  return outcome
}
