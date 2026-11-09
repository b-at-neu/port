// The release writer: the bump commit built and signed in the local clone (the operator's checkout is never touched), the two pull requests and the release itself. One audit entry per attempt; no ownership gate, since a release writes no pipeline label.
import { randomUUID } from 'node:crypto'
import { describe } from '@/main/github/release'
import { gh as defaultGh } from '@/main/platform/gh'
import { git as defaultGit } from '@/main/platform/git'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import { removeFile, writeTextFile } from '@/main/platform/files'
import { appendAudit } from '@/main/writes/audit'
import type { CommandResult } from '@/types/platform'
import type { BranchHead, ReleaseAuditAction, ReleaseAuditEntry, ReleaseWriteContext, ReleaseWriteResult, VersionFileWrite } from '@/types/release'
import { bumpBranchName, bumpSubject, releasePrTitle, releaseTag } from '@/utils/release/format'

async function record(ctx: ReleaseWriteContext, action: ReleaseAuditAction, call: readonly string[] | null, outcome: ReleaseWriteResult): Promise<ReleaseWriteResult> {
  const entry: ReleaseAuditEntry = {
    at: (ctx.now ?? (() => new Date()))().toISOString(),
    repo: ctx.repo,
    repoId: ctx.repoId,
    action,
    version: ctx.version,
    call,
    result: outcome.ok ? 'applied' : 'failed',
    failure: outcome.ok ? null : outcome.stderr,
  }
  await appendAudit(ctx.auditDir, entry)
  return outcome
}

// The scratch file is deleted in a `finally`; argv-length limits on Windows are why bodies never go inline.
async function withScratch(ctx: ReleaseWriteContext, name: string, text: string, use: (path: string) => Promise<ReleaseWriteResult>): Promise<{ readonly path: string; readonly result: ReleaseWriteResult }> {
  const path = (ctx.pathOps ?? defaultPathOps).join(ctx.scratchDir, `release-${name}-${randomUUID()}.txt`)
  const written = await writeTextFile(path, text)
  if (!written.ok) return { path, result: { ok: false, stderr: written.message } }
  try {
    return { path, result: await use(path) }
  } finally {
    await removeFile(path)
  }
}

async function run(ctx: ReleaseWriteContext, argv: readonly string[]): Promise<ReleaseWriteResult> {
  const result = await (ctx.gh ?? defaultGh)(argv)
  return result.ok ? { ok: true, stdout: result.stdout } : { ok: false, stderr: describe(result) }
}

function describeGit(result: Exclude<CommandResult, { ok: true }>): string {
  switch (result.kind) {
    case 'nonzero':
      return result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim() !== '' ? result.stdout.trim() : `git exited ${String(result.code)}`
    case 'timeout':
      return `git timed out after ${String(result.timeoutMs)} ms`
    default:
      return `git ${result.kind}`
  }
}

const SIGN_TIMEOUT_MS = 120_000

function signingFailure(detail: string): string {
  return `Couldn't sign the bump commit, so nothing was pushed. The app signs with your git config (user.signingkey, gpg.format): check the key is set and its agent is unlocked, then try again.\n\n${detail}`
}

interface GitCall {
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
}

// Each call is remembered as the audit's `call`, so a failure names the git command that ran last.
function bumpGit(ctx: ReleaseWriteContext, trace: { last: readonly string[] | null }): (call: GitCall) => Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly detail: string }> {
  return async ({ args, env, timeoutMs }) => {
    trace.last = ['git', ...args]
    const result = await (ctx.git ?? defaultGit)(args, { cwd: ctx.root, env, timeoutMs })
    return result.ok ? { ok: true, stdout: result.stdout } : { ok: false, detail: describeGit(result) }
  }
}

type BumpStep = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly stderr: string }

async function buildBump(ctx: ReleaseWriteContext, params: { readonly head: BranchHead; readonly files: readonly VersionFileWrite[]; readonly integration: string }, indexPath: string, git: ReturnType<typeof bumpGit>): Promise<BumpStep> {
  const branch = bumpBranchName(ctx.version)
  const fetched = await git({ args: ['fetch', '--no-tags', 'origin', `refs/heads/${params.integration}`] })
  if (!fetched.ok) return { ok: false, stderr: fetched.detail }
  const known = await git({ args: ['cat-file', '-e', `${params.head.oid}^{commit}`] })
  if (!known.ok) return { ok: false, stderr: `origin in ${ctx.root} doesn't have ${params.head.oid} — check that this clone's origin is ${ctx.repo}.` }
  const existing = await git({ args: ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`] })
  if (!existing.ok) return { ok: false, stderr: existing.detail }
  if (existing.stdout.trim() !== '') return { ok: false, stderr: `${branch} already exists on origin. Delete it, or cut this release with /port:release.` }

  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  const read = await git({ args: ['read-tree', params.head.tree], env })
  if (!read.ok) return { ok: false, stderr: read.detail }
  for (const file of params.files) {
    const staged = await withScratch(ctx, 'blob', file.content, async (path) => {
      const blob = await git({ args: ['hash-object', '-w', '--no-filters', '--', path], env })
      if (!blob.ok) return { ok: false, stderr: blob.detail }
      const added = await git({ args: ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${file.path}`], env })
      return added.ok ? { ok: true, stdout: '' } : { ok: false, stderr: added.detail }
    })
    if (!staged.result.ok) return { ok: false, stderr: staged.result.stderr }
  }
  const tree = await git({ args: ['write-tree'], env })
  if (!tree.ok) return { ok: false, stderr: tree.detail }

  const committed = await git({ args: ['commit-tree', tree.stdout.trim(), '-p', params.head.oid, '-S', '-m', bumpSubject(ctx.version)], env, timeoutMs: SIGN_TIMEOUT_MS })
  if (!committed.ok) return { ok: false, stderr: signingFailure(committed.detail) }
  const sha = committed.stdout.trim()
  const header = await git({ args: ['cat-file', 'commit', sha] })
  if (!header.ok) return { ok: false, stderr: header.detail }
  if (!/^gpgsig(-sha256)? /m.test(header.stdout.split(/\r?\n\r?\n/)[0] ?? '')) return { ok: false, stderr: signingFailure('git produced a commit with no signature.') }

  const pushed = await git({ args: ['push', 'origin', `${sha}:refs/heads/${branch}`] })
  return pushed.ok ? { ok: true, sha } : { ok: false, stderr: pushed.detail }
}

/**
 * Builds the bump commit in the registered clone under a throwaway index, signs it with the operator's own git config and
 * pushes it to a new `bump/v<version>`. The checkout, its index and its HEAD are never touched, and an unsigned commit is never pushed.
 */
export async function createBumpBranch(ctx: ReleaseWriteContext, params: { readonly head: BranchHead; readonly files: readonly VersionFileWrite[]; readonly integration: string }): Promise<ReleaseWriteResult> {
  const trace: { last: readonly string[] | null } = { last: null }
  const indexPath = (ctx.pathOps ?? defaultPathOps).join(ctx.scratchDir, `release-index-${randomUUID()}`)
  try {
    const built = await buildBump(ctx, params, indexPath, bumpGit(ctx, trace))
    return record(ctx, 'release-bump', trace.last, built.ok ? { ok: true, stdout: built.sha } : { ok: false, stderr: built.stderr })
  } finally {
    await removeFile(indexPath)
    await removeFile(`${indexPath}.lock`)
  }
}

async function createPr(ctx: ReleaseWriteContext, params: { readonly base: string; readonly head: string; readonly title: string; readonly body: string; readonly assignee: string | null }): Promise<ReleaseWriteResult> {
  let argv: readonly string[] | null = null
  const { result } = await withScratch(ctx, 'pr', params.body, (path) => {
    argv = ['pr', 'create', '--repo', ctx.repo, '--base', params.base, '--head', params.head, '--title', params.title, '--body-file', path, ...(params.assignee === null ? [] : ['--assignee', params.assignee])]
    return run(ctx, argv)
  })
  return record(ctx, 'release-pr', argv, result)
}

export function openBumpPr(ctx: ReleaseWriteContext, params: { readonly integration: string }): Promise<ReleaseWriteResult> {
  const body = `Bumps the version to v${ctx.version} ahead of its release.\n`
  return createPr(ctx, { base: params.integration, head: bumpBranchName(ctx.version), title: bumpSubject(ctx.version), body, assignee: null })
}

/** `assignee` is the signed-in login the status read resolved; `null` leaves the pull request unassigned. */
export function openReleasePr(ctx: ReleaseWriteContext, params: { readonly production: string; readonly integration: string; readonly body: string; readonly assignee: string | null }): Promise<ReleaseWriteResult> {
  return createPr(ctx, { base: params.production, head: params.integration, title: releasePrTitle(ctx.version), body: params.body, assignee: params.assignee })
}

/** Creates the release and its tag at `target`; `gh release create` is the only thing that ever makes the tag. */
export async function publishRelease(ctx: ReleaseWriteContext, params: { readonly target: string; readonly notes: string }): Promise<ReleaseWriteResult> {
  const tag = releaseTag(ctx.version)
  let argv: readonly string[] | null = null
  const { result } = await withScratch(ctx, 'notes', params.notes, (path) => {
    argv = ['release', 'create', tag, '--repo', ctx.repo, '--target', params.target, '--title', tag, '--notes-file', path, '--latest']
    return run(ctx, argv)
  })
  return record(ctx, 'release-publish', argv, result)
}

/** The hook's own audit line — written by the channel, since the hook runs outside this directory. */
export function recordHook(ctx: ReleaseWriteContext, call: readonly string[] | null, outcome: ReleaseWriteResult): Promise<ReleaseWriteResult> {
  return record(ctx, 'release-hook', call, outcome)
}
