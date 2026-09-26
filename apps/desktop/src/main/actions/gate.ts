// The plan gate's composition root (#92): registry lookup, the preflight
// fetch, pure classification, the claim read/write, and — for an answer —
// the ordered comment-then-swap write. No `gh` import here — the read comes
// from `../github`, the write from `../writes`, exactly the `main/claim.ts`
// idiom of composing rather than reaching into either directly.
import { buildGatePlan, classifyGate } from '../../shared/gate/classify'
import type { GateClassifyItem, GatePlan } from '../../shared/gate/classify'
import { GATE_CLAIM_OWNER } from '../../shared/gate/types'
import type { GateAction, GateAnswerResponse, GateClaimResponse, GateDecision, GatePreflight, GatePreflightResponse } from '../../shared/gate/types'
import type { GatePreflightFetch } from '../../shared/github/types'
import { labelName } from '../../shared/labels/vocabulary'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { ClaimRead, LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import { fetchGatePreflight } from '../github'
import { IMPLEMENTATION_PLAN_HEADING, sessionRequiredMarkerAt } from '../state'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import { applyLabels, postComment, readGateClaim, releaseGateClaim, takeGateClaim } from '../writes'
import type { ApplyLabelsParams, PostCommentParams } from '../writes'

type ReadyEntry = Extract<RepositoryEntry, { readonly status: 'ready' }>

/** The seam every composition below is testable through, without Electron,
 *  a real registry, or a real `gh`/`git` — the same idiom `main/claim.ts`'s
 *  own `ClaimDeps` gives. Every default export is what production wiring
 *  supplies. */
export interface GateDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchGatePreflight: typeof fetchGatePreflight
  readonly readGateClaim: typeof readGateClaim
  readonly takeGateClaim: typeof takeGateClaim
  readonly releaseGateClaim: typeof releaseGateClaim
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
  readonly now: () => Date
}

export const defaultGateDeps: GateDeps = {
  listRepositories,
  fetchGatePreflight,
  readGateClaim,
  takeGateClaim,
  releaseGateClaim,
  applyLabels,
  postComment,
  now: () => new Date(),
}

async function resolveReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, deps: Pick<GateDeps, 'listRepositories'>): Promise<ReadyEntry> {
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`gate requires the registry, which could not be listed: ${list.message}`)
  const entry = list.repositories.find((repository) => repository.id === repoId)
  if (!entry) throw new Error(`gate found no repository registered with id '${repoId}'`)
  if (!('config' in entry)) throw new Error(`gate requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
}

/** Splits the fetched issue body at `IMPLEMENTATION_PLAN_HEADING` — the
 *  ticket half above it (trimmed of trailing blank lines), the plan half
 *  (heading included) below, `null` when the heading is absent entirely —
 *  the same "no plan section" case the Reviewing step's own no-plan note
 *  renders. */
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

/** `'gate:preflight'`'s composition: resolve the `ready` entry, read the
 *  claim, then fetch and classify against that entry's own resolved
 *  vocabulary — never a second config read. The claim rides along on every
 *  response arm, since the Claim step renders regardless of whether the item
 *  itself resolved. */
export async function gatePreflight(params: GatePreflightParams, deps: GateDeps = defaultGateDeps): Promise<GatePreflightResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const claim = await deps.readGateClaim({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })

  const fetch = await deps.fetchGatePreflight({ repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message, claim }

  const autoPlanName = labelName(entry.config.vocabulary, 'autoPlan')
  const preflight = toGatePreflight(fetch, autoPlanName)
  const verdict = classifyGate({ item: toClassifyItem(fetch.item, fetch.viewer), vocabulary: entry.config.vocabulary })
  if (preflight === null) return { kind: 'unresolved', claim }
  return { kind: 'resolved', preflight, verdict, claim }
}

export interface GateClaimReadParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
}

/** `'gate:claim:read'`'s composition — the Claim step's own re-read, called
 *  fresh every time the dialog opens at that step rather than reusing the
 *  preflight's own (potentially stale) claim reading. */
export async function gateClaimRead(params: GateClaimReadParams, deps: GateDeps = defaultGateDeps): Promise<ClaimRead> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  return deps.readGateClaim({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
}

export interface GateClaimSetParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  /** The target state the operator's own button names — `true` to take the
   *  claim, `false` to release it. Never a toggle read off the current
   *  state, so a stale dialog can only ever ask for the state its own button
   *  showed. */
  readonly held: boolean
}

/**
 * `'gate:claim:set'`'s composition. A claim is created or released only by
 * this explicit operator action (`docs/COORDINATION.md`'s own lifecycle
 * rule) — nothing here takes or releases a claim on any machine-observed
 * condition. Always re-reads afterwards, so the response carries the state
 * as it now is rather than as it was asked to be.
 */
export async function gateClaimSet(params: GateClaimSetParams, deps: GateDeps = defaultGateDeps): Promise<GateClaimResponse> {
  const entry = await resolveReadyEntry(params.registryDeps, params.repoId, deps)
  const result = params.held
    ? await deps.takeGateClaim({ repoRoot: entry.path, repo: entry.config.repo, owner: GATE_CLAIM_OWNER, scopes: ['plan-gate'], now: deps.now })
    : await deps.releaseGateClaim({ repoRoot: entry.path })
  if (!result.ok) return { kind: 'failed', result }
  const claim = await deps.readGateClaim({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
  return { kind: 'ok', claim }
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
  /** The operator's own feedback text, verbatim — required for
   *  `request-changes` unless `skipComment` is set; ignored for `approve`. */
  readonly feedback: string | null
  /** `true` only on a retry after a comment already landed and the label
   *  swap alone failed — suppresses the comment, never widens the write
   *  (plan's own **Ordering**: a renderer-supplied `skipComment` can only
   *  ever suppress a write, never widen one). */
  readonly skipComment: boolean
  readonly auditDir: string
  readonly scratchDir: string
}

/**
 * `'gate:answer'`'s composition, in the plan's own fixed order: resolve
 * entry → fetch preflight → classify (refuse anything but `answerable`) →
 * for `request-changes` with `skipComment: false`, `postComment` — a
 * non-`applied` outcome aborts as `comment-failed`, with no label ever
 * touched — → `applyLabels`. The feedback comment is the operator's text
 * verbatim, with no heading added, so `plan-agent` in revision mode sees one
 * artifact regardless of which writer produced it.
 */
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
      auditDir: params.auditDir,
    })
    if (comment.kind !== 'applied') return { kind: 'comment-failed', comment }
  }

  const plan = buildGatePlan(params.decision)
  const action: GateAction = params.decision === 'approve' ? 'approve-plan' : 'request-plan-changes'
  const labels = await deps.applyLabels({ request: buildWriteRequest(entry, params.number, plan, action), repoRoot: entry.path, auditDir: params.auditDir })
  return { kind: 'answered', comment, labels }
}
