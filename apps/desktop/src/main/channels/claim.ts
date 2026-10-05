// `'claim:preflight'`/`'claim:apply'`'s own validation — moved out of
// `main/ipc.ts` verbatim (#365), the same split every other topic there
// already follows.
import { PLAN_GATE_CHOICES } from '../../shared/claim/types'
import type { IpcMap } from '../../shared/ipc'
import { claimApply, claimPreflight, defaultClaimDeps } from '../claim'
import type { ClaimDeps } from '../claim'
import type { RegistryDeps } from '../registry'

/** `'claim:preflight'`'s validation: `repoId` must name a currently
 *  registered repository (the same rail `resolveWorktreesReport` already
 *  applies) and `number` a positive integer. */
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

/** `'claim:apply'`'s validation — the same `repoId`/`number` rail
 *  `resolveClaimPreflight` applies, plus `planGate` restricted to
 *  `PLAN_GATE_CHOICES` and `confirmedAssignees` restricted to an array of
 *  strings: everything a human or the renderer's own state could get wrong
 *  is a thrown error here, never a value `claimApply` has to defend against
 *  (#72's rule). */
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
