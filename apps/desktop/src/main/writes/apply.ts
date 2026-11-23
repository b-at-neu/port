// The write chokepoint's two entry points. Both functions append exactly one audit entry per
// attempt, aborts included.
import { randomUUID } from 'node:crypto'
import { gh as defaultGh } from '@/main/platform/gh'
import type { GhResult } from '@/types/platform'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import { removeFile, writeTextFile } from '@/main/platform/files'
import { readItemsByNumber } from '@/main/github/tracker/items'

import type { GitHubRepoRef } from '@/types/github'
import type { AssertEqual } from '@/types/assert-type'
import type { GhWriteFailureKind, LabelAuditEntry, LabelWriteRequest, ObservedItem, OwnershipKind, WriteOutcome } from '@/types/writes'
import { appendAudit } from '@/main/writes/audit'
import { buildCommand } from '@/main/writes/command'
import { readOwnership } from '@/main/dispatch/ownership'
import { wouldChangeNothing } from '@/main/writes/scope'
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
  readonly request: Pick<LabelWriteRequest, 'repo' | 'repoId' | 'kind' | 'number' | 'action'>
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
export async function applyLabels(params: ApplyLabelsParams): Promise<WriteOutcome> {
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const gh = params.gh ?? defaultGh
  const { auditDir, observed } = params
  const request = { repo: params.repo, repoId: params.repoId, kind: params.kind, number: params.number, action: params.action }

  // The writer already read ownership; this is the second line behind it.
  const ownership = await readOwnership({ repoRoot: params.repoRoot, repo: params.repo, git: params.git, pathOps, now })
  if (ownership.kind === 'terminal') {
    const outcome: WriteOutcome = { kind: 'terminal-owned', since: ownership.since }
    await recordLabelAudit(auditDir, { request, ownership: 'terminal', observed, call: null, writeId: params.writeId }, outcome, now)
    return outcome
  }
  if (ownership.kind === 'unreadable') {
    const outcome: WriteOutcome = { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message }
    await recordLabelAudit(auditDir, { request, ownership: 'unreadable', observed, call: null, writeId: params.writeId }, outcome, now)
    return outcome
  }

  const ctx: AuditContext = { request, ownership: ownership.kind, observed, call: null, writeId: params.writeId }
  if (wouldChangeNothing(params, observed)) {
    const outcome: WriteOutcome = { kind: 'no-op' }
    await recordLabelAudit(auditDir, ctx, outcome, now)
    return outcome
  }

  const argv = buildCommand(params)
  const result = await gh(argv)
  const ctxWithCall: AuditContext = { ...ctx, call: argv }

  if (!result.ok) {
    const reread = await (params.fetchItemsByNumber ?? readItemsByNumber)({ repo: splitRepo(params.repo), numbers: [params.number] })
    const rereadItem = reread.ok ? reread.resolved.find((item) => item.number === params.number) : undefined
    const rereadObserved: ObservedItem | null = rereadItem ? { labels: rereadItem.labels, assignees: rereadItem.assignees, readAt: reread.fetchedAt } : null
    const outcome: WriteOutcome = { kind: 'write-failed', classification: result.kind, stderr: describeGhFailure(result), reread: rereadObserved }
    await recordLabelAudit(auditDir, ctxWithCall, outcome, now)
    return outcome
  }

  const outcome: WriteOutcome = { kind: 'applied', argv }
  await recordLabelAudit(auditDir, ctxWithCall, outcome, now)
  return outcome
}

/** Passes `--body-file` from a scratch file, deleted in a `finally` — argv-length limits on Windows
 *  are the reason, not shell quoting. Audited with byte length, never the text. */
async function postBodyFile(params: PostCommentParams, argvFor: (scratchPath: string) => readonly string[], refusal: string | null): Promise<WriteOutcome> {
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const gh = params.gh ?? defaultGh
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

  const ownership = await readOwnership({ repoRoot: params.repoRoot, repo: request.repo, git: params.git, pathOps, now })
  if (ownership.kind === 'terminal') {
    return record('terminal', null, { kind: 'terminal-owned', since: ownership.since })
  }
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
    const result = await gh(argv)
    if (!result.ok) {
      return await record(ownership.kind, argv, { kind: 'write-failed', classification: result.kind, stderr: describeGhFailure(result), reread: null })
    }
    return await record(ownership.kind, argv, { kind: 'applied', argv })
  } finally {
    await removeFile(scratchPath)
  }
}

export async function postComment(params: PostCommentParams): Promise<WriteOutcome> {
  const { request } = params
  const subcommand = request.kind === 'pull-request' ? 'pr' : 'issue'
  return postBodyFile(params, (scratchPath) => [subcommand, 'comment', String(request.number), '--repo', request.repo, '--body-file', scratchPath], null)
}

/** The only issue-body write: replaces the issue's whole body from a scratch file. Never edits a pull request. */
export async function postIssueBody(params: PostCommentParams): Promise<WriteOutcome> {
  const { request } = params
  const refusal = request.kind === 'pull-request' ? 'an issue body write never edits a pull request' : null
  return postBodyFile(params, (scratchPath) => ['issue', 'edit', String(request.number), '--repo', request.repo, '--body-file', scratchPath], refusal)
}
