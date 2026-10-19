import type { ApplyLabelsParams, PostCommentParams } from '@/types/writes'
import type { FetchItemsByNumberParams } from '@/types/github'
import type { ReadyEntry, RebaseDecision, RebasePick, UnblockRoute } from '@/types/actions'

// applyItemDecision — unblock and revise, the comment-then-swap write
// `main/actions/gate.ts`'s own `gateAnswer` already establishes.
import { decisionPlan, decisionsFor, isCycleCapEscalation, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import { changesRequestedBody, gateClearedBody } from '@/utils/actions/bodies'
import type { ItemDecisionResult } from '@/types/actions'
import { stageKeyOf } from '@/utils/actions/plan'
import { labelName } from '@/utils/labels/vocabulary'
import type { ReconciledItem } from '@/types/state'
import type { LabelWriteRequest, ObservedItem, WriteOutcome } from '@/types/writes'
import { evaluate } from '@/main/writes/scope'
import { applyLabels, postComment } from '@/main/writes/apply'

import { fetchItemsByNumber } from '@/main/github/adapter'

import type { ItemsByNumberFetch } from '@/types/github'
import { findRepoState, movedResult } from '@/main/actions/apply'

import type { ApplyItemDecisionParams } from '@/types/actions'

export interface ApplyItemDecisionDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
}

export const defaultApplyItemDecisionDeps: ApplyItemDecisionDeps = { applyLabels, postComment, fetchItemsByNumber }

function findItem(repoState: ReturnType<typeof findRepoState>, number: number): ReconciledItem | null {
  if (repoState === null) return null
  return repoState.items.find((item) => item.kind === 'pull-request' && item.number === number) ?? null
}

// Fixed order: find the item, refuse moved, check availability, validate a
// revise note, re-read fresh, post the comment, then swap the labels.
export async function applyItemDecision(params: ApplyItemDecisionParams, deps: ApplyItemDecisionDeps = defaultApplyItemDecisionDeps): Promise<ItemDecisionResult> {
  const { request, snapshot, entry, auditDir, scratchDir } = params
  const repoState = findRepoState(snapshot, entry.id)
  if (repoState === null) return { ok: false, reason: 'repo-unavailable' }

  const item = findItem(repoState, request.number)
  if (item === null) return movedResult(entry.config.vocabulary, request.expectedStage, 'gone')

  const currentStage = stageKeyOf(item)
  if (currentStage !== request.expectedStage) return movedResult(entry.config.vocabulary, request.expectedStage, currentStage)

  const availability = decisionsFor({ item, viewer: repoState.viewer, reviewCycleCap: repoState.reviewCycleCap })[request.decision]
  if (!availability.available) {
    if (availability.reason === 'viewer-unknown') return { ok: false, reason: 'viewer-unknown' }
    if (availability.reason === 'not-owned') return { ok: false, reason: 'not-owned', owners: item.assignees }
    if (availability.reason === 'not-applicable') {
      throw new Error(`'${request.decision}' is not applicable to pull request #${String(request.number)}`)
    }
    return { ok: false, reason: 'refused', refusal: availability.reason }
  }

  const headRefOid = 'headRefOid' in availability.context ? availability.context.headRefOid : null
  if (request.decision === 'revise') {
    if (request.note === null || headRefOid === null) throw new Error(`'revise' requires a note and a head SHA for #${String(request.number)}`)
    const problem = reviseNoteProblem(request.note, headRefOid)
    if (problem !== null) return { ok: false, reason: 'refused', refusal: 'note-invalid', problem }
  }

  const decisions = 'decisions' in availability.context ? availability.context.decisions : []
  const picks = request.picks ?? []
  const picksIssue = picksRefusal(decisions, picks, request.route)
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
  const observed: ObservedItem = { labels: fresh.labels, assignees: fresh.assignees, readAt: fetch.fetchedAt }
  const verdict = evaluate({ presentNames, absentNames, assignees: plan.expect.assignees }, observed)
  if (!verdict.satisfied) {
    return { ok: false, reason: 'moved', expected: verdict.expected.join(', ') || 'nothing', observed: verdict.observed.join(', ') || 'nothing' }
  }

  let comment: WriteOutcome | null = null
  if (!request.skipComment) {
    const cycleGrant = request.decision === 'unblock' && request.route === 'revision' && isCycleCapEscalation(item.comments)
    const body =
      request.decision === 'unblock'
        ? gateClearedBody(request.route === 'revision' ? 'revision' : 'review', { cycleGrant, rebaseDecisions: chosenOptions(decisions, picks) })
        : changesRequestedBody(headRefOid ?? '', request.note ?? '')
    comment = await deps.postComment({
      request: { repoId: entry.id, repo: entry.config.repo, kind: 'pull-request', number: request.number, body, action: request.decision, scratchDir },
      repoRoot: entry.path,
      auditDir,
    })
    if (comment.kind !== 'applied') return { ok: false, reason: 'comment-failed', comment }
  }

  const labels = await deps.applyLabels({
    request: buildWriteRequest(entry, request.number, plan),
    repoRoot: entry.path,
    auditDir,
  })
  return { ok: true, comment, labels }
}

// Rebase decisions only ever go back to revision, the one stage that applies them.
function picksRefusal(decisions: readonly RebaseDecision[], picks: readonly RebasePick[], route: UnblockRoute | null): string | null {
  if (decisions.length === 0) return picks.length === 0 ? null : 'unexpected'
  if (route !== 'revision') return 'route'
  return picksProblem(decisions, picks)
}

// Path and label come from main's own parse; the renderer only ever chose letters.
function chosenOptions(decisions: readonly RebaseDecision[], picks: readonly RebasePick[]) {
  return decisions.map((decision) => {
    const letter = picks.find((pick) => pick.id === decision.id)?.letter ?? ''
    return { id: decision.id, path: decision.path, letter, label: decision.options.find((option) => option.letter === letter)?.label ?? '' }
  })
}

function buildWriteRequest(entry: ReadyEntry, number: number, plan: ReturnType<typeof decisionPlan>): LabelWriteRequest {
  return {
    repoId: entry.id,
    repo: entry.config.repo,
    kind: 'pull-request',
    number,
    vocabulary: entry.config.vocabulary,
    add: plan.add,
    remove: plan.remove,
    addAssignees: [],
    removeAssignees: [],
    expect: plan.expect,
    action: plan.action,
  }
}
