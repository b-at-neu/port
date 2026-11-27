import type { GateClassifyItem } from '@/types/gate'
import type { OperatorMove, ReadyEntry } from '@/types/actions'

// No `gh` import here — the read comes from `ctx.tracker`, the write from `../writes`.
import { classifyGate } from '@/main/pipeline/gate/classify'

import type { GateAnswerResponse, GatePreflight, GatePreflightResponse } from '@/types/gate'
import type { GatePreflightFetch } from '@/types/github'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import type { OwnershipSummary, WriteOutcome } from '@/types/writes'
import { IMPLEMENTATION_PLAN_HEADING, sessionRequiredMarkerAt } from '@/main/pipeline/board/link'
import { readyEntryOf, type OperatorContext, type StateWriteContext } from '@/main/pipeline/context'
import { postComment } from '@/main/github/writes/apply'

import { readOwnership, toOwnershipSummary } from '@/main/repos/ownership'
import { UNSEEDED_MESSAGE } from '@/main/pipeline/state/labels'
import { liveTicketOf, writeMove } from '@/main/pipeline/operator/apply'

import type { AutoApprovePlanParams, GateAnswerParams, GatePreflightParams } from '@/types/actions'

function resolveReadyEntry(ctx: OperatorContext, repoId: RepoId) {
  return readyEntryOf(ctx, 'gate', repoId, (message) => `gate requires the registry, which could not be listed: ${message}`)
}

/** Splits at `IMPLEMENTATION_PLAN_HEADING`; `null` plan half when the heading is absent. */
function splitBody(body: string): { readonly ticketMarkdown: string; readonly planMarkdown: string | null } {
  const idx = body.indexOf(IMPLEMENTATION_PLAN_HEADING)
  if (idx === -1) return { ticketMarkdown: body, planMarkdown: null }
  return { ticketMarkdown: body.slice(0, idx).trimEnd(), planMarkdown: body.slice(idx) }
}

function toGatePreflight(fetch: Extract<GatePreflightFetch, { readonly ok: true }>, ticket: Ticket | null): GatePreflight | null {
  const { item } = fetch
  if (item === null) return null
  const { ticketMarkdown, planMarkdown } = splitBody(item.body)
  const reason = item.kind === 'issue' ? sessionRequiredMarkerAt(item.body, 'issue') : null
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    assignees: item.assignees,
    viewer: fetch.viewer,
    ticketMarkdown,
    planMarkdown,
    sessionRequired: reason !== null,
    sessionRequiredReason: reason,
    autoPlan: ticket?.autoPlan === true,
    readAt: fetch.fetchedAt,
  }
}

function toClassifyItem(item: Extract<GatePreflightFetch, { readonly ok: true }>['item'], viewer: string, ticket: Ticket | null): GateClassifyItem | null {
  if (item === null) return null
  return { kind: item.kind, number: item.number, ticket, assignees: item.assignees, viewer, noPlanBlock: !item.body.includes(IMPLEMENTATION_PLAN_HEADING) }
}

/** `false` while the repository's pipeline state is unseeded. */
function seeded(ctx: StateWriteContext, entry: ReadyEntry): boolean {
  return ctx.stores.pipelineState.tickets(entry.id) !== null
}

function liveTicketFor(ctx: StateWriteContext, entry: ReadyEntry, item: Extract<GatePreflightFetch, { readonly ok: true }>['item']): Ticket | null {
  return item === null ? null : liveTicketOf(ctx, entry.id, item.kind, item.number)
}

// Ownership rides along on every response arm; the dialog disables controls under unreadable regardless.
export async function gatePreflight(ctx: OperatorContext, params: GatePreflightParams): Promise<GatePreflightResponse> {
  const entry = await resolveReadyEntry(ctx, params.repoId)
  const ownership: OwnershipSummary = toOwnershipSummary(await readOwnership(ctx, { repoRoot: entry.path, repo: entry.config.repo }))

  const fetch = await ctx.tracker.readGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message, ownership }

  if (!seeded(ctx, entry)) return { kind: 'failed', message: UNSEEDED_MESSAGE, ownership }
  const ticket = liveTicketFor(ctx, entry, fetch.item)
  const preflight = toGatePreflight(fetch, ticket)
  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer, ticket) })
  if (preflight === null) return { kind: 'unresolved', ownership }
  return { kind: 'resolved', preflight, verdict, ownership }
}

// A non-`applied` comment outcome aborts as `comment-failed`, with no label ever touched.
export async function gateAnswer(ctx: OperatorContext, params: GateAnswerParams): Promise<GateAnswerResponse> {
  const entry = await resolveReadyEntry(ctx, params.repoId)
  const fetch = await ctx.tracker.readGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'preflight-failed', message: fetch.message }

  if (!seeded(ctx, entry)) return { kind: 'answered', comment: null, labels: { kind: 'state-unsaved', message: UNSEEDED_MESSAGE } }
  const ticket = liveTicketFor(ctx, entry, fetch.item)
  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer, ticket) })
  if (verdict.kind !== 'answerable' || ticket === null) return { kind: 'refused', verdict: verdict.kind === 'answerable' ? { kind: 'not-at-plan-review', observed: null } : verdict }

  let comment: WriteOutcome | null = null
  if (params.decision === 'request-changes' && !params.skipComment) {
    comment = await postComment(ctx, {
      request: {
        repoId: entry.id,
        repo: entry.config.repo,
        kind: 'issue',
        number: params.number,
        body: params.feedback ?? '',
        action: 'request-plan-changes',
        scratchDir: params.scratchDir,
      },
      repoRoot: entry.path,
      auditDir: params.auditDir,
    })
    if (comment.kind !== 'applied') return { kind: 'comment-failed', comment }
  }

  const move: OperatorMove = { kind: params.decision === 'approve' ? 'approve-plan' : 'request-plan-changes' }
  const labels = await writeMove(ctx, { entry, kind: 'issue', number: params.number, ticket, move, actor: fetch.viewer, assignees: { kind: 'any' }, addAssignees: [], auditDir: params.auditDir })
  return { kind: 'answered', comment, labels }
}

// No ownership read here — the caller already confirmed it, and the writer re-checks the ticket's `rev` at write time.
export async function autoApprovePlan(ctx: StateWriteContext, params: AutoApprovePlanParams): Promise<WriteOutcome> {
  const ticket = liveTicketOf(ctx, params.entry.id, 'issue', params.item.number)
  if (ticket === null) return { kind: 'item-unavailable' }
  if (!ticket.autoPlan) return { kind: 'no-op' }
  return writeMove(ctx, { entry: params.entry, kind: 'issue', number: params.item.number, ticket, move: { kind: 'approve-plan' }, actor: null, assignees: { kind: 'exactly', logins: params.item.assignees }, addAssignees: [], action: 'auto-approve-plan', auditDir: params.auditDir })
}
