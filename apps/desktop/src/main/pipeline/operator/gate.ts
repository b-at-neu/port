import type { GateClassifyItem, GatePlan } from '@/types/gate'
import type { ReadyEntry } from '@/types/actions'

// No `gh` import here — the read comes from `../github`, the write from `../writes`.
import { buildAutoApprovePlan, buildGatePlan, classifyGate } from '@/main/pipeline/gate/classify'

import type { GateAction, GateAnswerResponse, GatePreflight, GatePreflightResponse } from '@/types/gate'
import type { GatePreflightFetch } from '@/types/github'
import { mirrorVocabularyOf } from '@/utils/labels/display'
import { labelName } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { LabelWriteRequest, OwnershipSummary, WriteOutcome } from '@/types/writes'
import { IMPLEMENTATION_PLAN_HEADING, sessionRequiredMarkerAt } from '@/main/pipeline/board/link'
import { readyEntryOf, type OperatorContext, type StateWriteContext } from '@/main/pipeline/context'
import { fetchGatePreflight } from '@/main/github/tracker/gate'
import { postComment } from '@/main/github/writes/apply'

import { readOwnership, toOwnershipSummary } from '@/main/repos/ownership'
import { storedLabels, UNSEEDED_MESSAGE } from '@/main/pipeline/state/labels'
import { writeState } from '@/main/pipeline/state/writer'

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

function toGatePreflight(fetch: Extract<GatePreflightFetch, { readonly ok: true }>, autoPlanName: string | undefined, labels: readonly string[]): GatePreflight | null {
  const { item } = fetch
  if (item === null) return null
  const { ticketMarkdown, planMarkdown } = splitBody(item.body)
  const reason = item.kind === 'issue' ? sessionRequiredMarkerAt(item.body, 'issue') : null
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    labels,
    assignees: item.assignees,
    viewer: fetch.viewer,
    ticketMarkdown,
    planMarkdown,
    sessionRequired: reason !== null,
    sessionRequiredReason: reason,
    autoPlan: autoPlanName !== undefined && labels.includes(autoPlanName),
    readAt: fetch.fetchedAt,
  }
}

function toClassifyItem(item: Extract<GatePreflightFetch, { readonly ok: true }>['item'], viewer: string, labels: readonly string[]): GateClassifyItem | null {
  if (item === null) return null
  return { kind: item.kind, number: item.number, labels, assignees: item.assignees, viewer, noPlanBlock: !item.body.includes(IMPLEMENTATION_PLAN_HEADING) }
}

/** The store's labels for the item, `[]` for an absent one, and `null` while the repository is unseeded. */
function readStoredLabels(ctx: StateWriteContext, entry: ReadyEntry, item: Extract<GatePreflightFetch, { readonly ok: true }>['item']): readonly string[] | null {
  return item === null ? [] : storedLabels(ctx, entry.id, item.kind, item.number, entry.config.vocabulary)
}

// Ownership rides along on every response arm; the dialog disables controls under unreadable regardless.
export async function gatePreflight(ctx: OperatorContext, params: GatePreflightParams): Promise<GatePreflightResponse> {
  const entry = await resolveReadyEntry(ctx, params.repoId)
  const ownership: OwnershipSummary = toOwnershipSummary(await readOwnership(ctx, { repoRoot: entry.path, repo: entry.config.repo }))

  const fetch = await fetchGatePreflight(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message, ownership }

  const autoPlanName = labelName(entry.config.vocabulary, 'autoPlan')
  const labels = readStoredLabels(ctx, entry, fetch.item)
  if (labels === null) return { kind: 'failed', message: UNSEEDED_MESSAGE, ownership }
  const preflight = toGatePreflight(fetch, autoPlanName, labels)
  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer, labels), vocabulary: entry.config.vocabulary })
  if (preflight === null) return { kind: 'unresolved', ownership }
  return { kind: 'resolved', preflight, verdict, ownership }
}

function buildWriteRequest(entry: ReadyEntry, number: number, plan: GatePlan, action: GateAction): LabelWriteRequest {
  return {
    repoId: entry.id,
    repo: entry.config.repo,
    kind: 'issue',
    number,
    vocabulary: entry.config.vocabulary,
    mirror: mirrorVocabularyOf(entry.config),
    add: plan.add,
    remove: plan.remove,
    addAssignees: [],
    removeAssignees: [],
    expect: plan.expect,
    action,
  }
}

// A non-`applied` comment outcome aborts as `comment-failed`, with no label ever touched.
export async function gateAnswer(ctx: OperatorContext, params: GateAnswerParams): Promise<GateAnswerResponse> {
  const entry = await resolveReadyEntry(ctx, params.repoId)
  const fetch = await fetchGatePreflight(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'preflight-failed', message: fetch.message }

  const stored = readStoredLabels(ctx, entry, fetch.item)
  if (stored === null) return { kind: 'answered', comment: null, labels: { kind: 'state-unsaved', message: UNSEEDED_MESSAGE } }
  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer, stored), vocabulary: entry.config.vocabulary })
  if (verdict.kind !== 'answerable') return { kind: 'refused', verdict }

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

  const plan = buildGatePlan(params.decision)
  const action: GateAction = params.decision === 'approve' ? 'approve-plan' : 'request-plan-changes'
  const labels = await writeState(ctx, { request: buildWriteRequest(entry, params.number, plan, action), repoRoot: entry.path, auditDir: params.auditDir })
  return { kind: 'answered', comment, labels }
}

// No ownership read here — the caller already confirmed it, and `writeState` re-checks at write time.
export async function autoApprovePlan(ctx: StateWriteContext, params: AutoApprovePlanParams): Promise<WriteOutcome> {
  const plan = buildAutoApprovePlan({ vocabulary: params.entry.config.vocabulary, assignees: params.item.assignees })
  return writeState(ctx, { request: buildWriteRequest(params.entry, params.item.number, plan, 'auto-approve-plan'), repoRoot: params.entry.path, auditDir: params.auditDir })
}
