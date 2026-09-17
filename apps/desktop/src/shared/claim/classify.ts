// Pure claim-scope classification and request-building — no `gh`, no
// filesystem. `classifyPreflight` never resolves a `gh` call itself; the
// caller (`main/claim.ts`) supplies the already-fetched `ClaimPreflight`.
// `buildClaimRequest` resolves no `LabelKey` either — the vocabulary rides
// along on the returned `LabelWriteRequest` for `main/writes/command.ts` to
// resolve, the same idiom every other write request already follows.
import { labelName } from '../labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { LabelWriteRequest } from '../writes/types'
import type { RepoId } from '../repos'
import type { ClaimPreflight, ClaimVerdict, PlanGateChoice } from './types'

/** `plugins/port/skills/pipeline/SKILL.md`'s own "work on #N" paragraph
 *  names exactly these three `<labels.X>` keys — `scripts/checks/
 *  desktop-claim.mjs` pins this set against that paragraph, both
 *  directions. `autoPlan` is kept separate from `CLAIM_LABEL_KEYS` rather
 *  than folded in, since it is conditional on the operator's plan-gate
 *  choice and the other two never are. */
export const CLAIM_LABEL_KEYS: readonly LabelKey[] = ['marker', 'ready']
export const AUTO_PLAN_KEY: LabelKey = 'autoPlan'

/** `item: null` is `ClaimPreflightFetch`'s own "the number does not exist or
 *  its alias errored" case, passed straight through as `not-found` — never
 *  a thrown error, since a mistyped number is an ordinary outcome here. */
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

/** Builds the opt-in `LabelWriteRequest` from a `claimable` verdict. Every
 *  field here is derivable from `preflight`/`verdict`/`planGate` alone —
 *  nothing is asked of the caller that this function could instead compute,
 *  so a caller cannot understate what it claims. `expect.absent` names
 *  `marker` unconditionally (the plan's own **Data & contracts**: claiming
 *  an item already in the pipeline would add `ready` beside a live in-flight
 *  label, which every stage agent's label-CAS contract treats as
 *  impossible), and `addAssignees`/`removeAssignees` are derived from the
 *  observed assignee set, never from the caller's own belief about it, so an
 *  idempotent re-claim lands in `applyLabels`'s `no-op` arm rather than
 *  spawning a pointless `gh` call. */
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
