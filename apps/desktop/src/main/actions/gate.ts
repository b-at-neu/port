import type { GateClassifyItem, GateDeps, GatePlan } from '@/types/gate'
import type { ReadyEntry } from '@/types/actions'

// No `gh` import here — the read comes from `../github`, the write from `../writes`.
import { buildAutoApprovePlan, buildGatePlan, classifyGate } from '@/main/gate/classify'

import type { GateAction, GateAnswerResponse, GatePreflight, GatePreflightResponse } from '@/types/gate'
import type { GatePreflightFetch } from '@/types/github'
import { labelName } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { LabelWriteRequest, OwnershipSummary, WriteOutcome } from '@/types/writes'
import { IMPLEMENTATION_PLAN_HEADING, sessionRequiredMarkerAt } from '@/main/state/link'
import { requireReadyRepo } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'

import { toOwnershipSummary } from '@/main/dispatch/ownership'

import type { AutoApprovePlanParams, GateAnswerParams, GatePreflightParams } from '@/types/actions'

function resolveReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, deps: Pick<GateDeps, 'listRepositories'>) {
  return requireReadyRepo(
    registryDeps,
    'gate',
    repoId,
    deps.listRepositories,
    (message) => `gate requires the registry, which could not be listed: ${message}`,
  )
}

/** Splits at `IMPLEMENTATION_PLAN_HEADING`; `null` plan half when the heading is absent. */
function splitBody(body: string): { readonly ticketMarkdown: string; readonly planMarkdown: string | null } {
  const idx = body.indexOf(IMPLEMENTATION_PLAN_HEADING)
  if (idx === -1) return { ticketMarkdown: body, planMarkdown: null }
  return { ticketMarkdown: body.slice(0, idx).trimEnd(), planMarkdown: body.slice(idx) }
}

function toGatePreflight(fetch: Extract<GatePreflightFetch, { readonly ok: true }>, autoPlanName: string | undefined, labels: readonly string[] | null): GatePreflight | null {
  const { item } = fetch
  if (item === null) return null
  const stateLabels = labels ?? item.labels
  const { ticketMarkdown, planMarkdown } = splitBody(item.body)
  const reason = item.kind === 'issue' ? sessionRequiredMarkerAt(item.body, 'issue') : null
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    labels: stateLabels,
    assignees: item.assignees,
    viewer: fetch.viewer,
    ticketMarkdown,
    planMarkdown,
    sessionRequired: reason !== null,
    sessionRequiredReason: reason,
    autoPlan: autoPlanName !== undefined && stateLabels.includes(autoPlanName),
    readAt: fetch.fetchedAt,
  }
}

function toClassifyItem(item: Extract<GatePreflightFetch, { readonly ok: true }>['item'], viewer: string, labels: readonly string[] | null): GateClassifyItem | null {
  if (item === null) return null
  return { kind: item.kind, number: item.number, labels: labels ?? item.labels, assignees: item.assignees, viewer, noPlanBlock: !item.body.includes(IMPLEMENTATION_PLAN_HEADING) }
}

function storedLabels(entry: ReadyEntry, item: Extract<GatePreflightFetch, { readonly ok: true }>['item'], deps: Pick<GateDeps, 'stateLabels'>): readonly string[] | null {
  return item === null ? null : deps.stateLabels(entry.id, item.kind, item.number, entry.config.vocabulary)
}

// Ownership rides along on every response arm; the dialog disables controls under terminal/unreadable regardless.
export async function gatePreflight(params: GatePreflightParams, deps: GateDeps): Promise<GatePreflightResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const ownership: OwnershipSummary = toOwnershipSummary(await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now }))

  const fetch = await deps.fetchGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message, ownership }

  const autoPlanName = labelName(entry.config.vocabulary, 'autoPlan')
  const labels = storedLabels(entry, fetch.item, deps)
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
    add: plan.add,
    remove: plan.remove,
    addAssignees: [],
    removeAssignees: [],
    expect: plan.expect,
    action,
  }
}

// A non-`applied` comment outcome aborts as `comment-failed`, with no label ever touched.
export async function gateAnswer(params: GateAnswerParams, deps: GateDeps): Promise<GateAnswerResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const fetch = await deps.fetchGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'preflight-failed', message: fetch.message }

  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer, storedLabels(entry, fetch.item, deps)), vocabulary: entry.config.vocabulary })
  if (verdict.kind !== 'answerable') return { kind: 'refused', verdict }

  let comment: WriteOutcome | null = null
  if (params.decision === 'request-changes' && !params.skipComment) {
    comment = await deps.postComment({
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
  const labels = await deps.writeState({ request: buildWriteRequest(entry, params.number, plan, action), repoRoot: entry.path, auditDir: params.auditDir })
  return { kind: 'answered', comment, labels }
}

// No ownership read here — the caller already confirmed it, and `writeState` re-checks at write time.
export async function autoApprovePlan(params: AutoApprovePlanParams, deps: Pick<GateDeps, 'writeState'>): Promise<WriteOutcome> {
  const plan = buildAutoApprovePlan({ vocabulary: params.entry.config.vocabulary, assignees: params.item.assignees })
  return deps.writeState({ request: buildWriteRequest(params.entry, params.item.number, plan, 'auto-approve-plan'), repoRoot: params.entry.path, auditDir: params.auditDir })
}
