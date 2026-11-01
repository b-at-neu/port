// The release writer: the bump commit through the Git Data API (the operator's checkout is never touched), the two pull requests and the release itself. One audit entry per attempt; no ownership gate, since a release writes no pipeline label.
import { randomUUID } from 'node:crypto'
import { gh as defaultGh } from '@/main/platform/gh'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import { removeFile, writeTextFile } from '@/main/platform/files'
import { appendAudit } from '@/main/writes/audit'
import type { GhResult } from '@/types/platform'
import type { BranchHead, ReleaseAuditAction, ReleaseAuditEntry, ReleaseWriteContext, ReleaseWriteResult, VersionFileWrite } from '@/types/release'
import { bumpBranchName, bumpSubject, releasePrTitle, releaseTag } from '@/utils/release/format'

function describe(result: Exclude<GhResult, { ok: true }>): string {
  if ('stderr' in result && result.stderr.trim() !== '') return result.stderr.trim()
  if (result.kind === 'not-found') return "gh isn't on PATH"
  if (result.kind === 'spawn-failed') return result.message
  return result.kind
}

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

function apiPost(repo: string, endpoint: string, inputPath: string): readonly string[] {
  return ['api', '--method', 'POST', `repos/${repo}/${endpoint}`, '--input', inputPath, '--jq', '.sha']
}

async function postJson(ctx: ReleaseWriteContext, endpoint: string, body: unknown): Promise<{ readonly argv: readonly string[]; readonly result: ReleaseWriteResult }> {
  let argv: readonly string[] = []
  const { result } = await withScratch(ctx, endpoint.replace('/', '-'), JSON.stringify(body), (path) => {
    argv = apiPost(ctx.repo, endpoint, path)
    return run(ctx, argv)
  })
  return { argv, result }
}

/** Commits the version files onto the integration head and creates `bump/v<version>` from it. */
export async function createBumpBranch(ctx: ReleaseWriteContext, params: { readonly head: BranchHead; readonly files: readonly VersionFileWrite[] }): Promise<ReleaseWriteResult> {
  const tree = await postJson(ctx, 'git/trees', { base_tree: params.head.tree, tree: params.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })) })
  if (!tree.result.ok) return record(ctx, 'release-bump', tree.argv, tree.result)
  const commit = await postJson(ctx, 'git/commits', { message: bumpSubject(ctx.version), tree: tree.result.stdout.trim(), parents: [params.head.oid] })
  if (!commit.result.ok) return record(ctx, 'release-bump', commit.argv, commit.result)
  const ref = await postJson(ctx, 'git/refs', { ref: `refs/heads/${bumpBranchName(ctx.version)}`, sha: commit.result.stdout.trim() })
  return record(ctx, 'release-bump', ref.argv, ref.result)
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
