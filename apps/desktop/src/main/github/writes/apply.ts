// The write chokepoint's two entry points. Both functions append exactly one audit entry per
// attempt, aborts included.
import { randomUUID } from 'node:crypto'
import { hostFs } from '@/main/platform'
import type { GhResult } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'
import { removeFile, writeTextFile } from '@/main/platform/files'
import type { Tracker } from '@/main/github/tracker'
import type { GitHubWriteContext } from '@/main/github/context'

import type { GitHubRepoRef } from '@/types/github'
import type { AssertEqual } from '@/types/assert-type'
import type { GhWriteFailureKind, LabelAuditEntry, ObservedItem, OwnershipKind, WriteOutcome } from '@/types/writes'
import { appendAudit } from '@/main/github/writes/audit'
import { buildCommand } from '@/main/github/writes/command'
import { readOwnership } from '@/main/repos/ownership'
import { wouldChangeNothing } from '@/main/github/writes/scope'
import type { PostCommentParams, ApplyLabelsParams } from '@/types/writes'

// Fails to compile if `GhResult` grows a failure kind without `GhWriteFailureKind` growing to match.
type GhResultFailureKind = Exclude<GhResult, { ok: true }>['kind']
export const _kindsCoverGhResult: AssertEqual<GhWriteFailureKind, GhResultFailureKind> = true

function splitRepo(repo: string): GitHubRepoRef {
  const slash = repo.indexOf('/')
  if (slash === -1) return { owner: repo, name: '' }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
}

// Four kinds carry no `stderr` at all — described from their own fields instead.
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

interface AuditContext {
  readonly request: Pick<ApplyLabelsParams, 'repo' | 'repoId' | 'kind' | 'number' | 'action'>
  readonly ownership: OwnershipKind
  readonly observed: ObservedItem | null
  readonly call: readonly string[] | null
  readonly writeId: string | undefined
}

async function recordLabelAudit(auditDir: string, ctx: AuditContext, outcome: WriteOutcome, now: () => Date): Promise<void> {
  const entry: LabelAuditEntry = {
    at: now().toISOString(),
    repo: ctx.request.repo,
    repoId: ctx.request.repoId,
    kind: ctx.request.kind,
    number: ctx.request.number,
    action: ctx.request.action,
    ownership: ctx.ownership,
    precondition: null,
    observed: ctx.observed,
    call: ctx.call,
    commentBytes: null,
    result: outcome,
    ...(ctx.writeId === undefined ? {} : { writeId: ctx.writeId }),
  }
  await appendAudit(auditDir, entry)
}

// A successful outcome carries no resulting label set — the next poll reports what is actually there.
export async function applyLabels(ctx: GitHubWriteContext & { readonly tracker: Pick<Tracker, 'readItemsByNumber'> }, params: ApplyLabelsParams): Promise<WriteOutcome> {
  const now = ctx.clock.now
  const { auditDir, observed } = params
  const request = { repo: params.repo, repoId: params.repoId, kind: params.kind, number: params.number, action: params.action }

  // The writer already read ownership; this is the second line behind it.
  const ownership = await readOwnership({ git: ctx.git, fs: hostFs, clock: ctx.clock }, { repoRoot: params.repoRoot, repo: params.repo })
  if (ownership.kind === 'unreadable') {
    const outcome: WriteOutcome = { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message }
    await recordLabelAudit(auditDir, { request, ownership: 'unreadable', observed, call: null, writeId: params.writeId }, outcome, now)
    return outcome
  }

  const audit: AuditContext = { request, ownership: ownership.kind, observed, call: null, writeId: params.writeId }
  if (wouldChangeNothing(params, observed)) {
    const outcome: WriteOutcome = { kind: 'no-op' }
    await recordLabelAudit(auditDir, audit, outcome, now)
    return outcome
  }

  const argv = buildCommand(params)
  const result = await ctx.ghWrite(argv)
  const auditWithCall: AuditContext = { ...audit, call: argv }

  if (!result.ok) {
    const reread = await ctx.tracker.readItemsByNumber({ repo: splitRepo(params.repo), numbers: [params.number] })
    const rereadItem = reread.ok ? reread.resolved.find((item) => item.number === params.number) : undefined
    const rereadObserved: ObservedItem | null = rereadItem ? { labels: rereadItem.labels, assignees: rereadItem.assignees, readAt: reread.fetchedAt } : null
    const outcome: WriteOutcome = { kind: 'write-failed', classification: result.kind, stderr: describeGhFailure(result), reread: rereadObserved }
    await recordLabelAudit(auditDir, auditWithCall, outcome, now)
    return outcome
  }

  const outcome: WriteOutcome = { kind: 'applied', argv }
  await recordLabelAudit(auditDir, auditWithCall, outcome, now)
  return outcome
}

/** Passes `--body-file` from a scratch file, deleted in a `finally` — argv-length limits on Windows
 *  are the reason, not shell quoting. Audited with byte length, never the text. */
async function postBodyFile(ctx: GitHubWriteContext, params: PostCommentParams, argvFor: (scratchPath: string) => readonly string[], refusal: string | null): Promise<WriteOutcome> {
  const now = ctx.clock.now
  const { request, auditDir } = params
  const scratchPath = pathOps.join(request.scratchDir, `write-comment-${request.kind}-${request.number}-${randomUUID()}.md`)
  const bodyBytes = Buffer.byteLength(request.body, 'utf8')

  async function record(ownership: OwnershipKind, call: readonly string[] | null, outcome: WriteOutcome): Promise<WriteOutcome> {
    const entry: LabelAuditEntry = {
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

  const ownership = await readOwnership({ git: ctx.git, fs: hostFs, clock: ctx.clock }, { repoRoot: params.repoRoot, repo: request.repo })
  if (ownership.kind === 'unreadable') {
    return record('unreadable', null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })
  }
  if (refusal !== null) {
    return record(ownership.kind, null, { kind: 'write-failed', classification: 'unknown', stderr: refusal, reread: null })
  }

  const written = await writeTextFile(scratchPath, request.body)
  if (!written.ok) {
    return record(ownership.kind, null, { kind: 'write-failed', classification: 'unknown', stderr: written.message, reread: null })
  }

  try {
    const argv = argvFor(scratchPath)
    const result = await ctx.ghWrite(argv)
    if (!result.ok) {
      return await record(ownership.kind, argv, { kind: 'write-failed', classification: result.kind, stderr: describeGhFailure(result), reread: null })
    }
    return await record(ownership.kind, argv, { kind: 'applied', argv })
  } finally {
    await removeFile(scratchPath)
  }
}

export async function postComment(ctx: GitHubWriteContext, params: PostCommentParams): Promise<WriteOutcome> {
  const { request } = params
  const subcommand = request.kind === 'pull-request' ? 'pr' : 'issue'
  return postBodyFile(ctx, params, (scratchPath) => [subcommand, 'comment', String(request.number), '--repo', request.repo, '--body-file', scratchPath], null)
}

/** The only issue-body write: replaces the issue's whole body from a scratch file. Never edits a pull request. */
export async function postIssueBody(ctx: GitHubWriteContext, params: PostCommentParams): Promise<WriteOutcome> {
  const { request } = params
  const refusal = request.kind === 'pull-request' ? 'an issue body write never edits a pull request' : null
  return postBodyFile(ctx, params,(scratchPath) => ['issue', 'edit', String(request.number), '--repo', request.repo, '--body-file', scratchPath], refusal)
}
