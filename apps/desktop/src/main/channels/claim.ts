import type { ClaimDeps } from '@/types/claim'

// `'claim:preflight'`/`'claim:apply'`'s own validation, the same per-topic
// split every other channel here follows.
import { PLAN_GATE_CHOICES } from '@/types/claim'
import type { RepoId } from '@/utils/repos'
import type { PlanGateChoice } from '@/types/claim'
import { claimApply, claimPreflight } from '@/main/claim'

import type { RegistryDeps } from '@/types/registry'
import { requireRepoId } from '@/main/registry'

// `repoId` must name a currently registered repository, `number` a positive integer.
export async function resolveClaimPreflight(
  registryDeps: RegistryDeps,
  request: { readonly repoId: RepoId; readonly number: number },
  deps: ClaimDeps,
): ReturnType<typeof claimPreflight> {
  const repoId = requireRepoId(request?.repoId, "'claim:preflight'")
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'claim:preflight' requires 'number' to be a positive integer")
  }
  return claimPreflight({ registryDeps, repoId, number: request.number }, deps)
}

// The same `repoId`/`number` rail, plus `planGate`/`confirmedAssignees` shape checks.
export async function resolveClaimApply(
  registryDeps: RegistryDeps,
  request: { readonly repoId: RepoId; readonly number: number; readonly planGate: PlanGateChoice; readonly confirmedAssignees: readonly string[] },
  auditDir: string,
  deps: ClaimDeps,
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
  return claimApply(
    { registryDeps, repoId, number: request.number, planGate: request.planGate, confirmedAssignees: request.confirmedAssignees, auditDir },
    deps,
  )
}
