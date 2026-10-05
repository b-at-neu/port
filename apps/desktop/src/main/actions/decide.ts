// applyItemDecision — unblock and revise, the comment-then-swap write
// `main/actions/gate.ts`'s own `gateAnswer` already establishes.
import { decisionPlan, decisionsFor, reviseNoteProblem } from '../../shared/actions/decide'
import { changesRequestedBody, gateClearedBody } from '../../shared/actions/bodies'
import type { ItemDecisionResult, OperatorDecision, UnblockRoute } from '../../shared/actions/types'
import { stageKeyOf } from '../../shared/actions/plan'
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ReconciledItem } from '../../shared/state/types'
import type { LabelWriteRequest, ObservedItem, WriteOutcome } from '../../shared/writes/types'
import { evaluate } from '../writes/scope'
import { applyLabels, postComment } from '../writes/apply'
import type { ApplyLabelsParams, PostCommentParams } from '../writes/apply'
import { fetchItemsByNumber } from '../github/adapter'
import type { FetchItemsByNumberParams } from '../github/adapter'
import type { ItemsByNumberFetch } from '../../shared/github/types'
import { findRepoState, movedResult } from './apply'
import type { ReadyEntry } from './apply'

export interface ItemDecisionRequest {
  readonly repoId: RepoId
  readonly number: number
  readonly decision: OperatorDecision
  readonly expectedStage: LabelKey | null
  readonly route: UnblockRoute | null
  readonly note: string | null
  readonly skipComment: boolean
}

export interface ApplyItemDecisionParams {
  readonly request: ItemDecisionRequest
  readonly snapshot: BoardSnapshot
  readonly entry: ReadyEntry
  readonly auditDir: string
  readonly scratchDir: string
}

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
    const body =
      request.decision === 'unblock'
        ? gateClearedBody(request.route === 'revision' ? 'revision' : 'review')
        : changesRequestedBody(headRefOid ?? '', request.note ?? '')
    comment = await deps.postComment({
      request: { repoId: entry.id, repo: entry.config.repo, kind: 'pull-request', number: request.number, body, action: request.decision, scratchDir },
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
