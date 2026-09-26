// The claim dialog's composition root (#93): registry lookup, the preflight
// fetch, pure classification, and — for apply — the write chokepoint. No
// `gh` import here — the read comes from `./github`, the write from
// `./actions` (relocated by #92 — `main/actions/` is the app's only
// `applyLabels` caller), exactly the `main/writes/apply.ts` idiom of
// composing rather than reaching into either directly.
import { classifyPreflight, buildClaimRequest } from '../shared/claim/classify'
import type { ClaimApplyResponse, ClaimPreflight, ClaimPreflightResponse, PlanGateChoice } from '../shared/claim/types'
import type { ClaimPreflightFetch } from '../shared/github/types'
import type { RepoId, RepositoryEntry } from '../shared/repos'
import { fetchClaimPreflight } from './github'
import { listRepositories } from './registry'
import type { RegistryDeps } from './registry'
import { applyClaimLabels } from './actions/claim'
import type { ApplyLabelsParams, WriteOutcome } from './writes'

type ReadyEntry = Extract<RepositoryEntry, { readonly status: 'ready' }>

/** The two calls both channels compose — injected so the registry-lookup and
 *  classification branching below is testable without Electron, a real
 *  registry, or a real `gh`, the same seam every other `main/ipc.ts` deps
 *  interface already gives its own channel. `fetchClaimPreflight`'s and
 *  `applyClaimLabels`' own default exports are what production wiring
 *  supplies. */
export interface ClaimDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchClaimPreflight: typeof fetchClaimPreflight
  readonly applyClaimLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
}

export const defaultClaimDeps: ClaimDeps = { listRepositories, fetchClaimPreflight, applyClaimLabels }

async function resolveReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, deps: ClaimDeps): Promise<ReadyEntry> {
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`claim requires the registry, which could not be listed: ${list.message}`)
  const entry = list.repositories.find((repository) => repository.id === repoId)
  if (!entry) throw new Error(`claim found no repository registered with id '${repoId}'`)
  if (!('config' in entry)) throw new Error(`claim requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
}

/** Flattens `ClaimPreflightFetch`'s `item`/`viewer`/`fetchedAt` into the one
 *  object `classifyPreflight`/`buildClaimRequest` consume — `null` passes
 *  straight through so `classifyPreflight` reports `not-found` itself,
 *  rather than this function deciding that. */
function toClaimPreflight(fetch: Extract<ClaimPreflightFetch, { readonly ok: true }>): ClaimPreflight | null {
  if (fetch.item === null) return null
  return { ...fetch.item, viewer: fetch.viewer, readAt: fetch.fetchedAt }
}

export interface ClaimPreflightParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
}

/** `'claim:preflight'`'s composition: resolve the `ready` entry, fetch, then
 *  classify against that entry's own resolved vocabulary — never a second
 *  config read. */
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
  /** The exact assignee list the review step showed the operator —
   *  `claimApply` refuses to write when a fresh read disagrees, so consent
   *  can never be applied to a different person than the one they saw. */
  readonly confirmedAssignees: readonly string[]
  readonly auditDir: string
}

function sameAssigneeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((login) => bSet.has(login))
}

/**
 * `'claim:apply'`'s composition. **Re-runs the preflight itself** rather
 * than trusting anything the renderer held (the plan's own **Data &
 * contracts**): a fresh verdict that is no longer `claimable` refuses
 * without writing, and an assignee set that has moved since the operator
 * confirmed it refuses as `moved` — both before `buildClaimRequest` is ever
 * called, so `applyLabels`'s own read-verify-write is a second, independent
 * abort rather than the only one.
 */
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
    // `classifyPreflight` only returns `claimable` for a non-null item — the
    // type system cannot see that connection, so this is an unreachable
    // defensive fallback, not a real code path.
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
