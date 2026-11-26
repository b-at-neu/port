import { decisionPlan, decisionsFor, isCycleCapEscalation, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import { changesRequestedBody, gateClearedBody } from '@/utils/actions/bodies'
import type { ApplyItemDecisionParams, ItemDecisionResult, RebaseDecision, RebasePick } from '@/types/actions'
import { ticketViewOf } from '@/utils/pipeline/stages'
import type { ReconciledItem } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'
import { postComment } from '@/main/github/writes/apply'
import type { StateWriteContext } from '@/main/pipeline/context'
import { findRepoState, liveTicketOf, movedResult, viewMatches, writeMove } from '@/main/pipeline/operator/apply'

function findItem(repoState: ReturnType<typeof findRepoState>, number: number): ReconciledItem | null {
  if (repoState === null) return null
  return repoState.items.find((item) => item.number === number) ?? null
}

// Fixed order: find the item, refuse moved, check availability, validate a
// revise note, post the comment, then write the move.
export async function applyItemDecision(ctx: StateWriteContext, params: ApplyItemDecisionParams): Promise<ItemDecisionResult> {
  const { request, snapshot, entry, auditDir, scratchDir, liveStage } = params
  const repoState = findRepoState(snapshot, entry.id)
  if (repoState === null) return { ok: false, reason: 'repo-unavailable' }

  const found = findItem(repoState, request.number)
  if (found === null) return movedResult(request.expected, 'gone')

  const ticket = liveTicketOf(ctx, entry.id, found.kind, request.number)
  if (ticket === null || !viewMatches(request.expected, ticket)) return movedResult(request.expected, ticket === null ? null : ticketViewOf(ticket))
  const item: ReconciledItem = { ...found, ticket }

  const availability = decisionsFor({ view: ticketViewOf(ticket), item, viewer: repoState.viewer, reviewCycleCap: repoState.reviewCycleCap, liveStage })[request.decision]
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

  let comment: WriteOutcome | null = null
  if (!request.skipComment) {
    const body = commentBody(request, item, decisions, picks, headRefOid)
    if (body !== null) {
      comment = await postComment(ctx, {
        request: { repoId: entry.id, repo: entry.config.repo, kind: item.kind, number: request.number, body, action: request.decision, scratchDir },
        repoRoot: entry.path,
        auditDir,
      })
      if (comment.kind !== 'applied') return { ok: false, reason: 'comment-failed', comment }
    }
  }

  const labels = await writeMove(ctx, {
    entry,
    kind: item.kind,
    number: request.number,
    ticket,
    move: decisionPlan(request.decision, request.route),
    actor: viewer,
    assignees: { kind: 'exactly', logins: [viewer] },
    addAssignees: [],
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
