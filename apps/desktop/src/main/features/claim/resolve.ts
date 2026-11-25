// `'claim:preflight'`/`'claim:apply'`'s own validation, the same per-topic
// split every other channel here follows.
import { PLAN_GATE_CHOICES } from '@/types/claim'
import type { RepoId } from '@/utils/repos'
import type { PlanGateChoice } from '@/types/claim'
import { claimApply, claimPreflight } from '@/main/pipeline/claim'
import type { OperatorContext } from '@/main/pipeline/context'
import { requireRepoId } from '@/main/repos'

// `repoId` must name a currently registered repository, `number` a positive integer.
export async function resolveClaimPreflight(ctx: OperatorContext, request: { readonly repoId: RepoId; readonly number: number }): ReturnType<typeof claimPreflight> {
  const repoId = requireRepoId(request?.repoId, "'claim:preflight'")
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'claim:preflight' requires 'number' to be a positive integer")
  }
  return claimPreflight(ctx, { repoId, number: request.number })
}

// The same `repoId`/`number` rail, plus `planGate`/`confirmedAssignees` shape checks.
export async function resolveClaimApply(
  ctx: OperatorContext,
  request: { readonly repoId: RepoId; readonly number: number; readonly planGate: PlanGateChoice; readonly confirmedAssignees: readonly string[] },
  auditDir: string,
): ReturnType<typeof claimApply> {
  const repoId = requireRepoId(request?.repoId, "'claim:apply'")
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'claim:apply' requires 'number' to be a positive integer")
  }
  if (!(PLAN_GATE_CHOICES as readonly string[]).includes(request.planGate)) {
    throw new Error(`'claim:apply' requires 'planGate' to be one of ${PLAN_GATE_CHOICES.join(', ')}`)
  }
  if (!Array.isArray(request.confirmedAssignees) || !request.confirmedAssignees.every((login) => typeof login === 'string')) {
    throw new Error("'claim:apply' requires 'confirmedAssignees' to be an array of strings")
  }
  return claimApply(ctx, { repoId, number: request.number, planGate: request.planGate, confirmedAssignees: request.confirmedAssignees, auditDir })
}
