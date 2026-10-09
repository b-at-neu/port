// No `gh` import here — the read comes from `../github`, the write from `../writes`.
import { buildAutoApprovePlan, buildGatePlan, classifyGate } from '../../shared/gate/classify'
import type { GateClassifyItem, GatePlan } from '../../shared/gate/classify'
import type { GateAction, GateAnswerResponse, GateDecision, GatePreflight, GatePreflightResponse } from '../../shared/gate/types'
import type { GatePreflightFetch } from '../../shared/github/types'
import { labelName } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { LabelWriteRequest, OwnershipSummary, WriteOutcome } from '../../shared/writes/types'
import { fetchGatePreflight } from '../github/gate'
import { IMPLEMENTATION_PLAN_HEADING, sessionRequiredMarkerAt } from '../state/link'
import { listRepositories, requireReadyRepo } from '../registry'
import type { RegistryDeps } from '../registry'
import type { ReadyEntry } from './apply'
import { applyLabels, postComment } from '../writes/apply'
import { readOwnership, toOwnershipSummary } from '../dispatch/ownership'
import type { ApplyLabelsParams, PostCommentParams } from '../writes/apply'

export interface GateDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchGatePreflight: typeof fetchGatePreflight
  readonly readOwnership: typeof readOwnership
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
  readonly now: () => Date
}

export const defaultGateDeps: GateDeps = {
  listRepositories,
  fetchGatePreflight,
  readOwnership,
  applyLabels,
  postComment,
  now: () => new Date(),
}

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

function toGatePreflight(fetch: Extract<GatePreflightFetch, { readonly ok: true }>, autoPlanName: string | undefined): GatePreflight | null {
  const { item } = fetch
  if (item === null) return null
  const { ticketMarkdown, planMarkdown } = splitBody(item.body)
  const reason = item.kind === 'issue' ? sessionRequiredMarkerAt(item.body, 'issue') : null
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    labels: item.labels,
    assignees: item.assignees,
    viewer: fetch.viewer,
    ticketMarkdown,
    planMarkdown,
    sessionRequired: reason !== null,
    sessionRequiredReason: reason,
    autoPlan: autoPlanName !== undefined && item.labels.includes(autoPlanName),
    readAt: fetch.fetchedAt,
  }
}

function toClassifyItem(item: Extract<GatePreflightFetch, { readonly ok: true }>['item'], viewer: string): GateClassifyItem | null {
  if (item === null) return null
  return { kind: item.kind, number: item.number, labels: item.labels, assignees: item.assignees, viewer, noPlanBlock: !item.body.includes(IMPLEMENTATION_PLAN_HEADING) }
}

export interface GatePreflightParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
}

// Ownership rides along on every response arm; the dialog disables controls under terminal/unreadable regardless.
export async function gatePreflight(params: GatePreflightParams, deps: GateDeps = defaultGateDeps): Promise<GatePreflightResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const ownership: OwnershipSummary = toOwnershipSummary(await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now }))

  const fetch = await deps.fetchGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message, ownership }

  const autoPlanName = labelName(entry.config.vocabulary, 'autoPlan')
  const preflight = toGatePreflight(fetch, autoPlanName)
  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer), vocabulary: entry.config.vocabulary })
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

export interface GateAnswerParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
  readonly decision: GateDecision
  readonly feedback: string | null
  /** A renderer-supplied `skipComment` can only ever suppress the comment write, never widen it. */
  readonly skipComment: boolean
  readonly auditDir: string
  readonly scratchDir: string
}

// A non-`applied` comment outcome aborts as `comment-failed`, with no label ever touched.
export async function gateAnswer(params: GateAnswerParams, deps: GateDeps = defaultGateDeps): Promise<GateAnswerResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const fetch = await deps.fetchGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'preflight-failed', message: fetch.message }

  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer), vocabulary: entry.config.vocabulary })
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
  const labels = await deps.applyLabels({ request: buildWriteRequest(entry, params.number, plan, action), repoRoot: entry.path, auditDir: params.auditDir })
  return { kind: 'answered', comment, labels }
}

export interface AutoApprovePlanParams {
  readonly entry: ReadyEntry
  readonly item: { readonly number: number; readonly assignees: readonly string[] }
  readonly auditDir: string
}

// No ownership read here — the caller already confirmed it, and `applyLabels` re-checks at write time.
export async function autoApprovePlan(params: AutoApprovePlanParams, deps: GateDeps = defaultGateDeps): Promise<WriteOutcome> {
  const plan = buildAutoApprovePlan({ vocabulary: params.entry.config.vocabulary, assignees: params.item.assignees })
  return deps.applyLabels({ request: buildWriteRequest(params.entry, params.item.number, plan, 'auto-approve-plan'), repoRoot: params.entry.path, auditDir: params.auditDir })
}
