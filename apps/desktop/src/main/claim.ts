// No `gh` import here — the read comes from `./github`, the write from `./actions`.
import { classifyPreflight, buildClaimRequest } from '../shared/claim/classify'
import type { ClaimApplyResponse, ClaimPreflight, ClaimPreflightResponse, PlanGateChoice } from '../shared/claim/types'
import type { ClaimPreflightFetch } from '../shared/github/types'
import type { RepoId } from '../shared/repos'
import { fetchClaimPreflight } from './github/adapter'
import { listRepositories, requireReadyRepo } from './registry'
import type { RegistryDeps } from './registry'
import { applyClaimLabels } from './actions/claim'
import type { ApplyLabelsParams } from './writes/apply'
import type { WriteOutcome } from '../shared/writes/types'

export interface ClaimDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchClaimPreflight: typeof fetchClaimPreflight
  readonly applyClaimLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
}

export const defaultClaimDeps: ClaimDeps = { listRepositories, fetchClaimPreflight, applyClaimLabels }

function resolveReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, deps: ClaimDeps) {
  return requireReadyRepo(
    registryDeps,
    'claim',
    repoId,
    deps.listRepositories,
    (message) => `claim requires the registry, which could not be listed: ${message}`,
  )
}

// `null` passes straight through so `classifyPreflight` reports `not-found` itself.
function toClaimPreflight(fetch: Extract<ClaimPreflightFetch, { readonly ok: true }>): ClaimPreflight | null {
  if (fetch.item === null) return null
  return { ...fetch.item, viewer: fetch.viewer, readAt: fetch.fetchedAt }
}

export interface ClaimPreflightParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
}

export async function claimPreflight(params: ClaimPreflightParams, deps: ClaimDeps = defaultClaimDeps): Promise<ClaimPreflightResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const fetch = await deps.fetchClaimPreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message }

  const preflight = toClaimPreflight(fetch)
  const verdict = classifyPreflight({ item: preflight, vocabulary: entry.config.vocabulary })
  if (preflight === null) return { kind: 'unresolved' }
  return { kind: 'resolved', preflight, verdict }
}

export interface ClaimApplyParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
  readonly planGate: PlanGateChoice
  /** `claimApply` refuses to write when a fresh read disagrees, so consent never applies to
   *  someone else. */
  readonly confirmedAssignees: readonly string[]
  readonly auditDir: string
}

function sameAssigneeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((login) => bSet.has(login))
}

// **Re-runs the preflight itself** rather than trusting anything the renderer held.
export async function claimApply(params: ClaimApplyParams, deps: ClaimDeps = defaultClaimDeps): Promise<ClaimApplyResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const fetch = await deps.fetchClaimPreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'preflight-failed', message: fetch.message }

  const preflight = toClaimPreflight(fetch)
  const verdict = classifyPreflight({ item: preflight, vocabulary: entry.config.vocabulary })
  if (verdict.kind !== 'claimable') {
    return { kind: 'refused', verdict }
  }
  if (preflight === null) {
    // Unreachable defensive fallback — `classifyPreflight` only returns `claimable` for a non-null item.
    return { kind: 'refused', verdict: { kind: 'not-found' } }
  }

  if (!sameAssigneeSet(params.confirmedAssignees, preflight.assignees)) {
    return { kind: 'moved', confirmed: params.confirmedAssignees, current: preflight.assignees, readAt: preflight.readAt }
  }

  const request = buildClaimRequest({
    preflight,
    verdict,
    vocabulary: entry.config.vocabulary,
    repoId: params.repoId,
    repo: entry.config.repo,
    planGate: params.planGate,
  })

  const outcome = await deps.applyClaimLabels({ request, repoRoot: entry.path, auditDir: params.auditDir })
  return { kind: 'write', outcome }
}
