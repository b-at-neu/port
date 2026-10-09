// Pure claim-scope classification and request-building — no `gh`, no filesystem. The caller supplies the already-fetched `ClaimPreflight`.
import { labelName } from '../labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { LabelWriteRequest } from '../writes/types'
import type { RepoId } from '../repos'
import type { ClaimPreflight, ClaimVerdict, PlanGateChoice } from './types'

/** `autoPlan` is kept separate from `CLAIM_LABEL_KEYS`, conditional on the operator's plan-review choice while the other two never are. */
export const CLAIM_LABEL_KEYS: readonly LabelKey[] = ['marker', 'ready']
export const AUTO_PLAN_KEY: LabelKey = 'autoPlan'

/** `item: null` is "the number does not exist or its alias errored", passed through as `not-found` — never a thrown error. */
export function classifyPreflight(params: { readonly item: ClaimPreflight | null; readonly vocabulary: LabelVocabulary }): ClaimVerdict {
  const { item, vocabulary } = params
  if (item === null) return { kind: 'not-found' }
  if (item.kind === 'pull-request') return { kind: 'not-an-issue' }

  const marker = labelName(vocabulary, 'marker')
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
  readonly vocabulary: LabelVocabulary
  readonly repoId: RepoId
  readonly repo: string
  readonly planGate: PlanGateChoice
}): LabelWriteRequest {
  const { preflight, verdict, vocabulary, repoId, repo, planGate } = params
  const add: LabelKey[] = planGate === 'auto' ? [...CLAIM_LABEL_KEYS, AUTO_PLAN_KEY] : [...CLAIM_LABEL_KEYS]
  const viewer = preflight.viewer
  const addAssignees = preflight.assignees.includes(viewer) ? [] : [viewer]
  const removeAssignees = preflight.assignees.filter((login) => login !== viewer)
  const action = verdict.assigneeSituation === 'others' ? `work on #${String(preflight.number)} (take over)` : `work on #${String(preflight.number)}`

  return {
    repoId,
    repo,
    kind: 'issue',
    number: preflight.number,
    vocabulary,
    add,
    remove: [],
    addAssignees,
    removeAssignees,
    expect: {
      present: [],
      absent: ['marker'],
      assignees: verdict.assigneeSituation === 'unassigned' ? { kind: 'unassigned' } : { kind: 'exactly', logins: preflight.assignees },
    },
    action,
  }
}
