// applyLabels / postComment — the write chokepoint's two entry points.
// Every observed state comes from `fetchItemsByNumber` (`../github`), never
// a second query-building caller; every ownership read comes from
// `../dispatch/ownership`, never a second `.agents/cockpit.json` reader.
// Both functions append exactly one audit entry per attempt, aborts
// included.
import { randomUUID } from 'node:crypto'
import { gh as defaultGh } from '../platform/gh'
import type { GhResult, GhRunner } from '../platform/gh'
import { pathOps as defaultPathOps } from '../platform/paths'
import { removeFile, writeTextFile } from '../platform/files'
import type { PathOps } from '../platform/paths'
import { fetchItemsByNumber } from '../github/adapter'
import type { FetchItemsByNumberParams, RepoRef } from '../github/adapter'
import type { ItemsByNumberFetch } from '../../shared/github/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { AssertEqual } from '../../shared/assert-type'
import type { AuditEntry, CommentRequest, GhWriteFailureKind, LabelWriteRequest, ObservedItem, OwnershipKind, WriteOutcome } from '../../shared/writes/types'
import { appendAudit } from './audit'
import { buildCommand, resolveKeys } from './command'
import type { GitRunner as OwnershipGitRunner } from '../dispatch/ownership'
import { readOwnership } from '../dispatch/ownership'
import { evaluate, wouldChangeNothing } from './scope'

export type { GhRunner }

/** Fails to compile if the platform layer's `GhResult` grows a failure kind
 *  without `GhWriteFailureKind` (`shared/writes/types.ts`) growing to
 *  match — the same pin `main/github/adapter.ts` establishes for
 *  `PipelineFailureKind`. */
type GhResultFailureKind = Exclude<GhResult, { ok: true }>['kind']
export const _kindsCoverGhResult: AssertEqual<GhWriteFailureKind, GhResultFailureKind> = true

function splitRepo(repo: string): RepoRef {
  const slash = repo.indexOf('/')
  if (slash === -1) return { owner: repo, name: '' }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
}

function dedupeKeys(keys: readonly LabelKey[]): readonly LabelKey[] {
  return [...new Set(keys)]
}

/** Four `CommandResult` kinds carry no `stderr` at all (`not-found`,
 *  `cwd-missing`, `output-too-large`, `spawn-failed`) — this describes each
 *  from its own fields, the same idiom `main/reclaimer/report.ts`'s
 *  `describeCommandFailure` uses, so `result.stderr` is never read where
 *  the type does not guarantee it exists. */
function describeGhFailure(result: Exclude<GhResult, { ok: true }>): string {
  switch (result.kind) {
    case 'not-found':
      return `gh not found on PATH (searched: ${result.searched.join(', ')})`
    case 'cwd-missing':
      return `working directory does not exist: ${result.cwd}`
    case 'output-too-large':
      return `gh output exceeded ${result.maxBytes} bytes`
    case 'spawn-failed':
      return result.message
    default:
      return result.stderr
  }
}

export interface ApplyLabelsParams {
  readonly request: LabelWriteRequest
  readonly repoRoot: string
  /** `app.getPath('userData')` at the composition root — where
   *  `writes.jsonl` lives. */
  readonly auditDir: string
  readonly gh?: GhRunner
  readonly git?: OwnershipGitRunner
  readonly fetchItemsByNumber?: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

interface AuditContext {
  readonly request: LabelWriteRequest
  readonly ownership: OwnershipKind
  readonly precondition: AuditEntry['precondition']
  readonly observed: ObservedItem | null
  readonly call: readonly string[] | null
}

async function recordLabelAudit(auditDir: string, ctx: AuditContext, outcome: WriteOutcome, now: () => Date): Promise<void> {
  const entry: AuditEntry = {
    at: now().toISOString(),
    repo: ctx.request.repo,
    repoId: ctx.request.repoId,
    kind: ctx.request.kind,
    number: ctx.request.number,
    action: ctx.request.action,
    ownership: ctx.ownership,
    precondition: ctx.precondition,
    observed: ctx.observed,
    call: ctx.call,
    commentBytes: null,
    result: outcome,
  }
  await appendAudit(auditDir, entry)
}

/**
 * Fixed order (plan's own **Implementation**): resolve names → read
 * ownership (every write needs it now, not only a plan-gate-touching one) →
 * the authoritative read → evaluate the precondition → short-circuit
 * `no-op` → `gh(argv)` → on failure only, one best-effort re-read. Every
 * branch appends exactly one audit entry, aborts included. A successful
 * outcome carries no resulting label set — the next poll reports what is
 * actually there.
 */
export async function applyLabels(params: ApplyLabelsParams): Promise<WriteOutcome> {
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const gh = params.gh ?? defaultGh
  const doFetchItemsByNumber = params.fetchItemsByNumber ?? fetchItemsByNumber
  const { request, auditDir } = params

  // --- Resolve every LabelKey the request carries -----------------------
  const command = buildCommand(request)
  const expectPresent = resolveKeys(request.vocabulary, request.expect.present)
  const expectAbsent = resolveKeys(request.vocabulary, request.expect.absent)
  const unresolved = dedupeKeys([...(command.ok ? [] : command.unresolved), ...expectPresent.unresolved, ...expectAbsent.unresolved])

  const baseCtx: AuditContext = { request, ownership: 'absent', precondition: null, observed: null, call: null }

  if (unresolved.length > 0 || !command.ok) {
    const outcome: WriteOutcome = { kind: 'unresolvable-label', keys: unresolved }
    await recordLabelAudit(auditDir, baseCtx, outcome, now)
    return outcome
  }

  const precondition: AuditEntry['precondition'] = { present: expectPresent.names, absent: expectAbsent.names, assignees: request.expect.assignees }

  // --- Every write needs this app to own the repository, full stop — never
  // a per-label scope the way the old gate-claim derived one.
  const ownership = await readOwnership({ repoRoot: params.repoRoot, repo: request.repo, git: params.git, pathOps, now })
  if (ownership.kind === 'terminal') {
    const outcome: WriteOutcome = { kind: 'terminal-owned', since: ownership.since }
    await recordLabelAudit(auditDir, { ...baseCtx, ownership: 'terminal', precondition }, outcome, now)
    return outcome
  }
  if (ownership.kind === 'unreadable') {
    const outcome: WriteOutcome = { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message }
    await recordLabelAudit(auditDir, { ...baseCtx, ownership: 'unreadable', precondition }, outcome, now)
    return outcome
  }

  // --- The authoritative read, never a cached list ----------------------
  const verify = await doFetchItemsByNumber({ repo: splitRepo(request.repo), numbers: [request.number], gh })
  const ctxAfterOwnership: AuditContext = { request, ownership: ownership.kind, precondition, observed: null, call: null }

  if (!verify.ok) {
    const outcome: WriteOutcome = { kind: 'verify-failed', message: verify.message }
    await recordLabelAudit(auditDir, ctxAfterOwnership, outcome, now)
    return outcome
  }
  const resolvedItem = verify.resolved.find((item) => item.number === request.number)
  if (!resolvedItem || verify.unavailable.includes(request.number)) {
    const outcome: WriteOutcome = { kind: 'item-unavailable' }
    await recordLabelAudit(auditDir, ctxAfterOwnership, outcome, now)
    return outcome
  }

  const observed: ObservedItem = { labels: resolvedItem.labels, assignees: resolvedItem.assignees, readAt: verify.fetchedAt }
  const ctxWithObserved: AuditContext = { ...ctxAfterOwnership, observed }

  // --- Evaluate the precondition -----------------------------------------
  const verdict = evaluate({ presentNames: expectPresent.names, absentNames: expectAbsent.names, assignees: request.expect.assignees }, observed)
  if (!verdict.satisfied) {
    const outcome: WriteOutcome = {
      kind: 'precondition-failed',
      conflict: { kind: 'precondition-failed', expected: verdict.expected, observed: verdict.observed, readAt: observed.readAt },
    }
    await recordLabelAudit(auditDir, ctxWithObserved, outcome, now)
    return outcome
  }

  // --- The no-op arm: no gh call at all -----------------------------------
  if (wouldChangeNothing({ addNames: command.addNames, removeNames: command.removeNames, addAssignees: request.addAssignees, removeAssignees: request.removeAssignees }, observed)) {
    const outcome: WriteOutcome = { kind: 'no-op' }
    await recordLabelAudit(auditDir, ctxWithObserved, outcome, now)
    return outcome
  }

  // --- The write itself ----------------------------------------------------
  const result = await gh(command.argv)
  const ctxWithCall: AuditContext = { ...ctxWithObserved, call: command.argv }

  if (!result.ok) {
    const reread = await doFetchItemsByNumber({ repo: splitRepo(request.repo), numbers: [request.number], gh })
    const rereadItem = reread.ok ? reread.resolved.find((item) => item.number === request.number) : undefined
    const rereadObserved: ObservedItem | null = rereadItem ? { labels: rereadItem.labels, assignees: rereadItem.assignees, readAt: reread.fetchedAt } : null
    const outcome: WriteOutcome = { kind: 'write-failed', classification: result.kind, stderr: describeGhFailure(result), reread: rereadObserved }
    await recordLabelAudit(auditDir, ctxWithCall, outcome, now)
    return outcome
  }

  const outcome: WriteOutcome = { kind: 'applied', argv: command.argv }
  await recordLabelAudit(auditDir, ctxWithCall, outcome, now)
  return outcome
}

export interface PostCommentParams {
  readonly request: CommentRequest
  readonly repoRoot: string
  readonly auditDir: string
  readonly gh?: GhRunner
  readonly git?: OwnershipGitRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

/** Writes the body to a scratch file under `request.scratchDir` and passes
 *  `--body-file`, deleting the file in a `finally` — argv-length limits on
 *  Windows, not shell quoting, are the reason: the platform layer spawns
 *  with `shell: false`, so a fence in an inline `--body` is inert but a long
 *  body is not. The comment is audited with its byte length and target,
 *  never its text. Reads ownership first, the same as `applyLabels` — a
 *  comment is a GitHub write like any other, and `gateAnswer`'s own
 *  comment-then-swap order means a feedback comment can land before the
 *  label write ever checks ownership itself. */
export async function postComment(params: PostCommentParams): Promise<WriteOutcome> {
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const gh = params.gh ?? defaultGh
  const { request, auditDir } = params
  const subcommand = request.kind === 'pull-request' ? 'pr' : 'issue'
  const scratchPath = pathOps.join(request.scratchDir, `write-comment-${request.kind}-${request.number}-${randomUUID()}.md`)
  const bodyBytes = Buffer.byteLength(request.body, 'utf8')

  async function record(ownership: OwnershipKind, call: readonly string[] | null, outcome: WriteOutcome): Promise<WriteOutcome> {
    const entry: AuditEntry = {
      at: now().toISOString(),
      repo: request.repo,
      repoId: request.repoId,
      kind: request.kind,
      number: request.number,
      action: request.action,
      ownership,
      precondition: null,
      observed: null,
      call,
      commentBytes: bodyBytes,
      result: outcome,
    }
    await appendAudit(auditDir, entry)
    return outcome
  }

  const ownership = await readOwnership({ repoRoot: params.repoRoot, repo: request.repo, git: params.git, pathOps, now })
  if (ownership.kind === 'terminal') {
    return record('terminal', null, { kind: 'terminal-owned', since: ownership.since })
  }
  if (ownership.kind === 'unreadable') {
    return record('unreadable', null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })
  }

  const written = await writeTextFile(scratchPath, request.body)
  if (!written.ok) {
    return record(ownership.kind, null, { kind: 'write-failed', classification: 'unknown', stderr: written.message, reread: null })
  }

  try {
    const argv = [subcommand, 'comment', String(request.number), '--repo', request.repo, '--body-file', scratchPath]
    const result = await gh(argv)
    if (!result.ok) {
      return await record(ownership.kind, argv, { kind: 'write-failed', classification: result.kind, stderr: describeGhFailure(result), reread: null })
    }
    return await record(ownership.kind, argv, { kind: 'applied', argv })
  } finally {
    await removeFile(scratchPath)
  }
}
