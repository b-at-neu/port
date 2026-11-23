// Interactive-session worktree creation and the shared removal path. Never deletes a branch here (`stage-worktree.ts` releases stage branches); never forces removal without an explicit caller choice. Through `GitRunner` only — never a direct subprocess call.
import { randomBytes } from 'node:crypto'
import type { GitRunner } from '@/types/platform'
import type { Platform } from '@/main/platform'
import { resolveGitBaseRoot } from '@/main/platform/git'
import { pathOps } from '@/main/platform/paths'
import type { RemoveSessionWorktreeOutcome, CreateSessionWorktreeParams, CreateSessionWorktreeResult } from '@/types/workspace'

export function hex6(random: () => string): string {
  return random().slice(0, 6)
}

export const defaultRandom = (): string => randomBytes(4).toString('hex')

async function headSha(git: GitRunner, root: string): Promise<string | null> {
  const result = await git(['rev-parse', 'HEAD'], root)
  if (!result.ok) return null
  const sha = result.stdout.trim()
  return sha === '' ? null : sha
}

/** `check-ignore` exits 1 for "not ignored" — only that exit means a line must be appended; any
 *  other failure is reported rather than silently skipping the exclude step. */
export async function ensureIgnored(ctx: Pick<Platform, 'git' | 'fs'>, root: string, relativePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const { git } = ctx
  const checked = await git(['check-ignore', '-q', relativePath], root)
  if (checked.ok) return { ok: true }
  if (!(checked.kind === 'nonzero' && checked.code === 1)) {
    return { ok: false, message: `git check-ignore failed: ${'stderr' in checked ? checked.stderr : checked.kind}` }
  }

  const commonDirResult = await git(['rev-parse', '--git-common-dir'], root)
  if (!commonDirResult.ok) return { ok: false, message: 'could not resolve --git-common-dir to append the exclude file' }
  const commonDirRaw = commonDirResult.stdout.trim()
  const commonDir = pathOps.resolveFrom(root, commonDirRaw)
  const excludePath = pathOps.join(commonDir, 'info', 'exclude')

  const existing = await ctx.fs.readText(excludePath)
  const line = '/.claude/worktrees/'
  const priorContent = existing.ok ? existing.value : ''
  if (existing.ok && priorContent.split(/\r?\n/).some((l) => l.trim() === line)) return { ok: true }

  const nextContent = priorContent.length > 0 && !priorContent.endsWith('\n') ? `${priorContent}\n${line}\n` : `${priorContent}${line}\n`
  const written = await ctx.fs.writeText(excludePath, nextContent)
  if (!written.ok) return { ok: false, message: `could not write ${excludePath}: ${written.message}` }
  return { ok: true }
}

/** `<repo root>/.claude/worktrees/session-<6 hex>`, branch `session/<6 hex>`, created from the root's
 *  current `HEAD`. A path or branch collision retries once with fresh hex, then fails. */
export async function createSessionWorktree(ctx: Pick<Platform, 'git' | 'fs'>, params: CreateSessionWorktreeParams): Promise<CreateSessionWorktreeResult> {
  const { git } = ctx
  const { root } = params
  const random = params.random ?? defaultRandom

  const sha = await headSha(git, root)
  if (sha === null) return { ok: false, message: 'could not resolve HEAD in the root repository' }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const suffix = hex6(random)
    // Forward slashes: git accepts them as a pathspec on every platform, including Windows.
    const relativePath = `.claude/worktrees/session-${suffix}`
    const path = pathOps.join(root, '.claude', 'worktrees', `session-${suffix}`)
    const branch = `session/${suffix}`

    const added = await git(['worktree', 'add', '-b', branch, path, sha], root)
    if (!added.ok) {
      // A collision (path or branch already exists) is the one failure worth retrying with fresh hex.
      const message = added.kind === 'nonzero' ? added.stderr : added.kind
      if (attempt === 0 && added.kind === 'nonzero' && /already exists|already checked out/i.test(message)) continue
      return { ok: false, message: `git worktree add failed: ${message}` }
    }

    const ignored = await ensureIgnored(ctx, root, relativePath)
    if (!ignored.ok) return { ok: false, message: ignored.message }

    const configured = await git(['config', `branch.${branch}.portBase`, sha], root)
    if (!configured.ok) return { ok: false, message: `could not record portBase: ${configured.kind === 'nonzero' ? configured.stderr : configured.kind}` }

    return { ok: true, path, branch, baseSha: sha }
  }

  return { ok: false, message: 'could not create a session worktree after a collision retry' }
}

interface RemoveSessionWorktreeParams {
  readonly root: string
  readonly path: string
  readonly force: boolean
}

/** `git worktree remove` without `--force` unless the caller explicitly asks; the branch is left
 *  for the caller to release. "contains modified or untracked files" classifies as `dirty`, never `failed`. */
export async function removeSessionWorktree(ctx: Pick<Platform, 'git'>, params: RemoveSessionWorktreeParams): Promise<RemoveSessionWorktreeOutcome> {
  const args = params.force ? ['worktree', 'remove', '--force', params.path] : ['worktree', 'remove', params.path]
  const result = await ctx.git(args, params.root)
  if (result.ok) return { outcome: 'removed' }

  const message = result.kind === 'nonzero' ? result.stderr : result.kind
  if (result.kind === 'nonzero' && /contains modified or untracked files/i.test(message)) {
    return { outcome: 'dirty' }
  }
  return { outcome: 'failed', message }
}

interface RemoveSessionWorktreeAtParams {
  readonly path: string
  readonly force: boolean
}

/** Resolves the worktree's own base root before removing — `git worktree remove` must run from
 *  outside the tree it is removing, never from inside it. */
export async function removeSessionWorktreeAt(ctx: Pick<Platform, 'git'>, params: RemoveSessionWorktreeAtParams): Promise<RemoveSessionWorktreeOutcome> {
  const root = await resolveGitBaseRoot(ctx.git, params.path, pathOps)
  return removeSessionWorktree(ctx, { root, path: params.path, force: params.force })
}
