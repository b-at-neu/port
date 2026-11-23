import type { PostCommentParams, WriteStateParams } from '@/types/writes'
import { mirrorVocabularyOf } from '@/utils/labels/display'
import type { FetchItemsByNumberParams } from '@/types/github'
import type { ReadyEntry, RebaseDecision, RebasePick } from '@/types/actions'

// applyItemDecision — unblock, revise and grant, the comment-then-swap write
// `main/actions/gate.ts`'s own `gateAnswer` already establishes.
import { decisionPlan, decisionsFor, isCycleCapEscalation, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import { changesRequestedBody, gateClearedBody } from '@/utils/actions/bodies'
import type { ItemDecisionResult } from '@/types/actions'
import { stageKeyOf } from '@/utils/actions/plan'
import { labelName } from '@/utils/labels/vocabulary'
import type { ReconciledItem } from '@/types/state'
import type { LabelWriteRequest, ObservedItem, WriteOutcome } from '@/types/writes'
import { evaluate } from '@/main/writes/scope'

import type { ItemsByNumberFetch } from '@/types/github'
import type { StateLabelsReader } from '@/types/pipeline-state'
import { findRepoState, movedResult } from '@/main/actions/apply'

import type { ApplyItemDecisionParams } from '@/types/actions'

export interface ApplyItemDecisionDeps {
  readonly writeState: (params: WriteStateParams) => Promise<WriteOutcome>
  readonly stateLabels: StateLabelsReader
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
}

function findItem(repoState: ReturnType<typeof findRepoState>, number: number): ReconciledItem | null {
  if (repoState === null) return null
  return repoState.items.find((item) => item.number === number) ?? null
}

// Fixed order: find the item, refuse moved, check availability, validate a
// revise note, re-read fresh, post the comment, then swap the labels.
export async function applyItemDecision(params: ApplyItemDecisionParams, deps: ApplyItemDecisionDeps): Promise<ItemDecisionResult> {
  const { request, snapshot, entry, auditDir, scratchDir, liveStage } = params
  const repoState = findRepoState(snapshot, entry.id)
  if (repoState === null) return { ok: false, reason: 'repo-unavailable' }

  const item = findItem(repoState, request.number)
  if (item === null) return movedResult(entry.config.vocabulary, request.expectedStage, 'gone')

  const currentStage = stageKeyOf(item)
  if (currentStage !== request.expectedStage) return movedResult(entry.config.vocabulary, request.expectedStage, currentStage)

  const availability = decisionsFor({ item, viewer: repoState.viewer, reviewCycleCap: repoState.reviewCycleCap, liveStage })[request.decision]
  if (!availability.available) {
    if (availability.reason === 'viewer-unknown') return { ok: false, reason: 'viewer-unknown' }
    if (availability.reason === 'not-owned') return { ok: false, reason: 'not-owned', owners: item.assignees }
    if (availability.reason === 'not-applicable') {
      throw new Error(`'${request.decision}' is not applicable to item #${String(request.number)}`)
    }
    return { ok: false, reason: 'refused', refusal: availability.reason }
  }
  if (request.decision === 'unblock' && (request.route === 'implementation') !== (item.kind === 'issue')) {
    throw new Error(`unblock route '${String(request.route)}' does not fit ${item.kind} #${String(request.number)}`)
  }

  if (request.decision === 'unblock' && 'routes' in availability.context && (request.route === null || !availability.context.routes.includes(request.route))) {
    return { ok: false, reason: 'refused', refusal: 'route-unavailable' }
  }

  const headRefOid = 'headRefOid' in availability.context ? availability.context.headRefOid : null
  if (request.decision === 'revise') {
    if (request.note === null || headRefOid === null) throw new Error(`'revise' requires a note and a head SHA for #${String(request.number)}`)
    const problem = reviseNoteProblem(request.note, headRefOid)
    if (problem !== null) return { ok: false, reason: 'refused', refusal: 'note-invalid', problem }
  }

  const decisions = 'decisions' in availability.context ? availability.context.decisions : []
  const picks = request.picks ?? []
  const picksIssue = picksRefusal(decisions, picks)
  if (picksIssue !== null) return { ok: false, reason: 'refused', refusal: 'picks-invalid', problem: picksIssue }

  const viewer = repoState.viewer
  if (viewer === null) return { ok: false, reason: 'viewer-unknown' }

  const plan = decisionPlan(request.decision, item, request.route, viewer)

  const fetch = await deps.fetchItemsByNumber({ repo: { owner: entry.config.owner, name: entry.config.name }, numbers: [request.number] })
  if (!fetch.ok) return { ok: false, reason: 'verify-failed', message: fetch.message }
  const fresh = fetch.resolved.find((resolved) => resolved.number === request.number)
  if (fresh === undefined) return movedResult(entry.config.vocabulary, request.expectedStage, 'gone')

  const presentNames = plan.expect.present.map((key) => labelName(entry.config.vocabulary, key)).filter((name): name is string => name !== undefined)
  const absentNames = plan.expect.absent.map((key) => labelName(entry.config.vocabulary, key)).filter((name): name is string => name !== undefined)
  const observed: ObservedItem = { labels: deps.stateLabels(entry.id, item.kind, request.number, entry.config.vocabulary) ?? fresh.labels, assignees: fresh.assignees, readAt: fetch.fetchedAt }
  const verdict = evaluate({ presentNames, absentNames, assignees: plan.expect.assignees }, observed)
  if (!verdict.satisfied) {
    return { ok: false, reason: 'moved', expected: verdict.expected.join(', ') || 'nothing', observed: verdict.observed.join(', ') || 'nothing' }
  }

  let comment: WriteOutcome | null = null
  if (!request.skipComment) {
    const body = commentBody(request, item, decisions, picks, headRefOid)
    if (body !== null) {
      comment = await deps.postComment({
        request: { repoId: entry.id, repo: entry.config.repo, kind: item.kind, number: request.number, body, action: request.decision, scratchDir },
        repoRoot: entry.path,
        auditDir,
      })
      if (comment.kind !== 'applied') return { ok: false, reason: 'comment-failed', comment }
    }
  }

  const labels = await deps.writeState({
    request: buildWriteRequest(entry, item.kind, request.number, plan),
    repoRoot: entry.path,
    auditDir,
  })
  return { ok: true, comment, labels }
}

function commentBody(request: ApplyItemDecisionParams['request'], item: ReconciledItem, decisions: readonly RebaseDecision[], picks: readonly RebasePick[], headRefOid: string | null): string | null {
  if (request.decision === 'grant') return gateClearedBody('revision', { cycleGrant: true })
  if (request.decision === 'unblock') {
    const cycleGrant = request.route === 'revision' && isCycleCapEscalation(item.comments)
    return gateClearedBody(request.route ?? 'review', { cycleGrant, rebaseDecisions: chosenOptions(decisions, picks) })
  }
  return changesRequestedBody(headRefOid ?? '', request.note ?? '')
}

function picksRefusal(decisions: readonly RebaseDecision[], picks: readonly RebasePick[]): string | null {
  if (decisions.length === 0) return picks.length === 0 ? null : 'unexpected'
  return picksProblem(decisions, picks)
}

// Path and label come from main's own parse; the renderer only ever chose letters.
function chosenOptions(decisions: readonly RebaseDecision[], picks: readonly RebasePick[]) {
  return decisions.map((decision) => {
    const letter = picks.find((pick) => pick.id === decision.id)?.letter ?? ''
    return { id: decision.id, path: decision.path, letter, label: decision.options.find((option) => option.letter === letter)?.label ?? '' }
  })
}

function buildWriteRequest(entry: ReadyEntry, kind: ReconciledItem['kind'], number: number, plan: ReturnType<typeof decisionPlan>): LabelWriteRequest {
  return {
    repoId: entry.id,
    repo: entry.config.repo,
    kind,
    number,
    vocabulary: entry.config.vocabulary,
    mirror: mirrorVocabularyOf(entry.config),
    add: plan.add,
    remove: plan.remove,
    addAssignees: [],
    removeAssignees: [],
    expect: plan.expect,
    action: plan.action,
  }
}
