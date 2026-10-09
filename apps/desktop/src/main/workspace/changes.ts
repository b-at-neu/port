// A session's diff against its recorded base — size-capped, with an `output-too-large` fallback to `--numstat`. Through `GitRunner` only.
import { git as realGit } from '../platform/git'
import type { GitRunner } from '../platform/git'
import type { SessionChanges } from '../../shared/workspace/types'
import type { SessionWorkspace } from '../../shared/workspace/types'
import { parseUnifiedDiff } from './diff'

/** Caps the one call whose output scales with the diff itself; every other call here is metadata-sized. */
const DIFF_MAX_BYTES = 2_000_000

/** The diff call gets the byte cap; every other call keeps the runner's own default. */
function defaultChangesGit(): GitRunner {
  return (args, cwd) => {
    if (args[0] === 'diff' && args.includes('-U3')) return realGit(args, { cwd, maxBytes: DIFF_MAX_BYTES })
    return realGit(args, { cwd })
  }
}

export interface SessionChangesDeps {
  readonly git: GitRunner
  readonly now?: () => Date
}

export const defaultSessionChangesDeps: SessionChangesDeps = { git: defaultChangesGit() }

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
export async function computeSessionChanges(workspace: SessionWorkspace, deps: SessionChangesDeps = defaultSessionChangesDeps): Promise<SessionChanges> {
  const now = deps.now ?? (() => new Date())
  const readAt = now().toISOString()

  if (workspace.root === null) {
    return { ok: false, kind: 'not-git', message: `${workspace.folder} is not inside a git repository` }
  }
  if (workspace.base === null) {
    return { ok: false, kind: 'base-missing', message: 'no diff base is recorded for this session' }
  }

  const cwd = workspace.worktree?.path ?? workspace.root
  const base = workspace.base

  const baseCheck = await deps.git(['cat-file', '-e', `${base.sha}^{commit}`], cwd)
  if (!baseCheck.ok) {
    if (baseCheck.kind === 'cwd-missing') return { ok: false, kind: 'folder-missing', message: `${cwd} no longer exists` }
    return { ok: false, kind: 'base-missing', message: `base commit ${base.sha} is not reachable` }
  }

  const untrackedResult = await deps.git(['ls-files', '--others', '--exclude-standard'], cwd)
  if (!untrackedResult.ok) {
    if (untrackedResult.kind === 'cwd-missing') return { ok: false, kind: 'folder-missing', message: `${cwd} no longer exists` }
    return { ok: false, kind: 'git-failed', message: `git ls-files failed: ${untrackedResult.kind === 'nonzero' ? untrackedResult.stderr : untrackedResult.kind}` }
  }
  const untracked = toLines(untrackedResult.stdout)

  const diffResult = await deps.git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', base.sha, '--'], cwd)

  if (diffResult.ok) {
    const parsed = parseUnifiedDiff(diffResult.stdout)
    const summary = parsed.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))
    return { ok: true, base, files: parsed.files, untracked, binary: parsed.binary, summary, truncated: false, readAt }
  }

  if (diffResult.kind === 'cwd-missing') return { ok: false, kind: 'folder-missing', message: `${cwd} no longer exists` }

  if (diffResult.kind === 'output-too-large') {
    const numstatResult = await deps.git(['diff', '--numstat', base.sha], cwd)
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
