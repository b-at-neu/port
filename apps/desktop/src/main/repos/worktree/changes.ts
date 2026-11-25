// A session's diff against its recorded base — size-capped, with an `output-too-large` fallback to `--numstat`. Through `GitRunner` only.
import type { Platform } from '@/main/platform'
import type { SessionChanges } from '@/types/workspace'
import type { SessionWorkspace } from '@/types/workspace'
import { parseUnifiedDiff } from '@/main/repos/worktree/diff'

function toLines(stdout: string): readonly string[] {
  const trimmed = stdout.replace(/\r?\n$/, '')
  return trimmed === '' ? [] : trimmed.split(/\r?\n/)
}

interface NumstatRow {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

function parseNumstat(stdout: string): readonly NumstatRow[] {
  return toLines(stdout)
    .map((line): NumstatRow | null => {
      const [added, deleted, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t')
      if (added === undefined || deleted === undefined || path === '') return null
      if (added === '-' || deleted === '-') return { path, additions: 0, deletions: 0, binary: true }
      const additions = Number(added)
      const deletions = Number(deleted)
      if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return null
      return { path, additions, deletions, binary: false }
    })
    .filter((row): row is NumstatRow => row !== null)
}

/** Resolves one session's diff against `workspace.base`. `workspace.root: null` or
 *  `workspace.base: null` are reported without a single git call — there is nothing to diff. */
export async function computeSessionChanges(ctx: Pick<Platform, 'git' | 'clock'>, workspace: SessionWorkspace): Promise<SessionChanges> {
  const { git } = ctx
  const readAt = ctx.clock.now().toISOString()

  if (workspace.root === null) {
    return { ok: false, kind: 'not-git', message: `${workspace.folder} is not inside a git repository` }
  }
  if (workspace.base === null) {
    return { ok: false, kind: 'base-missing', message: 'no diff base is recorded for this session' }
  }

  const cwd = workspace.worktree?.path ?? workspace.root
  const base = workspace.base

  const baseCheck = await git(['cat-file', '-e', `${base.sha}^{commit}`], cwd)
  if (!baseCheck.ok) {
    if (baseCheck.kind === 'cwd-missing') return { ok: false, kind: 'folder-missing', message: `${cwd} no longer exists` }
    return { ok: false, kind: 'base-missing', message: `base commit ${base.sha} is not reachable` }
  }

  const untrackedResult = await git(['ls-files', '--others', '--exclude-standard'], cwd)
  if (!untrackedResult.ok) {
    if (untrackedResult.kind === 'cwd-missing') return { ok: false, kind: 'folder-missing', message: `${cwd} no longer exists` }
    return { ok: false, kind: 'git-failed', message: `git ls-files failed: ${untrackedResult.kind === 'nonzero' ? untrackedResult.stderr : untrackedResult.kind}` }
  }
  const untracked = toLines(untrackedResult.stdout)

  const diffResult = await git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', base.sha, '--'], cwd)

  if (diffResult.ok) {
    const parsed = parseUnifiedDiff(diffResult.stdout)
    const summary = parsed.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))
    return { ok: true, base, files: parsed.files, untracked, binary: parsed.binary, summary, truncated: false, readAt }
  }

  if (diffResult.kind === 'cwd-missing') return { ok: false, kind: 'folder-missing', message: `${cwd} no longer exists` }

  if (diffResult.kind === 'output-too-large') {
    const numstatResult = await git(['diff', '--numstat', base.sha], cwd)
    if (!numstatResult.ok) {
      return { ok: false, kind: 'git-failed', message: `git diff --numstat failed after truncation: ${numstatResult.kind === 'nonzero' ? numstatResult.stderr : numstatResult.kind}` }
    }
    const rows = parseNumstat(numstatResult.stdout)
    const summary = rows.filter((row) => !row.binary).map((row) => ({ path: row.path, additions: row.additions, deletions: row.deletions }))
    const binary = rows.filter((row) => row.binary).map((row) => row.path)
    return { ok: true, base, files: [], untracked, binary, summary, truncated: true, readAt }
  }

  return { ok: false, kind: 'git-failed', message: `git diff failed: ${diffResult.kind === 'nonzero' ? diffResult.stderr : diffResult.kind}` }
}
