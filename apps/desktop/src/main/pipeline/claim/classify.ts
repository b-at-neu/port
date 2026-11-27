// Pure claim-scope classification and request-building — no `gh`, no filesystem. The caller supplies the already-fetched `ClaimPreflight`.
import type { EventWriteRequest } from '@/types/writes'
import { displayNamesOf } from '@/main/pipeline/state/mirror'
import type { MirrorVocabulary } from '@/utils/labels/display'
import type { RepoId } from '@/utils/repos'
import type { ClaimPreflight, ClaimVerdict, PlanGateChoice } from '@/types/claim'

/** `item: null` is "the number does not exist or its alias errored", passed through as `not-found` — never a thrown error. */
export function classifyPreflight(params: { readonly item: ClaimPreflight | null; readonly mirror: MirrorVocabulary }): ClaimVerdict {
  const { item, mirror } = params
  if (item === null) return { kind: 'not-found' }
  if (item.kind === 'pull-request') return { kind: 'not-an-issue' }

  const [marker] = displayNamesOf(mirror.labels, ['port'])
  if (marker !== undefined && item.labels.includes(marker)) {
    return { kind: 'already-claimed', markerName: marker }
  }

  const others = item.assignees.filter((login) => login !== item.viewer)
  const assigneeSituation = item.assignees.length === 0 ? 'unassigned' : others.length === 0 ? 'mine' : 'others'

  return { kind: 'claimable', assigneeSituation, others, closed: item.state !== 'OPEN', blockers: item.blockers }
}

/** Every field is derivable from `preflight`/`verdict`/`planGate` alone, so a caller cannot understate what it claims. `addAssignees`/`removeAssignees` come from the observed assignee set, so an idempotent re-claim lands in `no-op` rather than a pointless `gh` call. */
export function buildClaimRequest(params: {
  readonly preflight: ClaimPreflight
  readonly verdict: Extract<ClaimVerdict, { kind: 'claimable' }>
  readonly mirror: MirrorVocabulary
  readonly repoId: RepoId
  readonly repo: string
  readonly planGate: PlanGateChoice
}): EventWriteRequest {
  const { preflight, verdict, mirror, repoId, repo, planGate } = params
  const viewer = preflight.viewer
  const addAssignees = preflight.assignees.includes(viewer) ? [] : [viewer]
  const removeAssignees = preflight.assignees.filter((login) => login !== viewer)
  const action = verdict.assigneeSituation === 'others' ? `work on #${String(preflight.number)} (take over)` : `work on #${String(preflight.number)}`

  return {
    repoId,
    repo,
    kind: 'issue',
    number: preflight.number,
    mirror,
    event: { kind: 'track', autoPlan: planGate === 'auto' },
    expectedRev: null,
    assignees: verdict.assigneeSituation === 'unassigned' ? { kind: 'unassigned' } : { kind: 'exactly', logins: preflight.assignees },
    addAssignees,
    removeAssignees,
    action,
  }
}
