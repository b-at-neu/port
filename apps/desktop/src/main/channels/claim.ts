// `'claim:preflight'`/`'claim:apply'`'s own validation, the same per-topic
// split every other channel here follows.
import { PLAN_GATE_CHOICES } from '../../shared/claim/types'
import type { IpcMap } from '../../shared/ipc'
import { claimApply, claimPreflight, defaultClaimDeps } from '../claim'
import type { ClaimDeps } from '../claim'
import type { RegistryDeps } from '../registry'

// `repoId` must name a currently registered repository, `number` a positive integer.
export async function resolveClaimPreflight(
  registryDeps: RegistryDeps,
  request: IpcMap['claim:preflight']['request'],
  deps: ClaimDeps = defaultClaimDeps,
): ReturnType<typeof claimPreflight> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'claim:preflight' requires a non-empty 'repoId'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'claim:preflight' requires 'number' to be a positive integer")
  }
  return claimPreflight({ registryDeps, repoId: request.repoId, number: request.number }, deps)
}

// The same `repoId`/`number` rail, plus `planGate`/`confirmedAssignees` shape checks.
export async function resolveClaimApply(
  registryDeps: RegistryDeps,
  request: IpcMap['claim:apply']['request'],
  auditDir: string,
  deps: ClaimDeps = defaultClaimDeps,
): ReturnType<typeof claimApply> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'claim:apply' requires a non-empty 'repoId'")
  }
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
    { registryDeps, repoId: request.repoId, number: request.number, planGate: request.planGate, confirmedAssignees: request.confirmedAssignees, auditDir },
    deps,
  )
}
