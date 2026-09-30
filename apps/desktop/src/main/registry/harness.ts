// The #52 half of the ticket: what a registered repository's checkout looks
// like to the harness that would actually dispatch agents in it. Every step
// degrades to a diagnostic rather than a failure — `git` absent or failing
// never invalidates a repository, since the config read inspect.ts does is
// filesystem-only and stands on its own.
import { pathOps, readJsonFile } from '../platform'
import type { CommandResult } from '../platform'

/** The seam every function below takes instead of importing `git` directly,
 *  so `harness.test.ts` runs against a fake runner and needs no real
 *  repository. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

export type CurrentBranch =
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'detached'; readonly sha: string }
  | { readonly kind: 'unavailable' }

/** `rev-parse --abbrev-ref HEAD`; a literal `HEAD` back means detached, so a
 *  second call resolves the short sha to name in the diagnostic. */
export async function currentBranch(git: GitRunner, cwd: string): Promise<CurrentBranch> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (!branch.ok) return { kind: 'unavailable' }
  const name = branch.stdout.trim()
  if (name !== 'HEAD') return { kind: 'branch', name }

  const sha = await git(['rev-parse', '--short', 'HEAD'], cwd)
  if (!sha.ok) return { kind: 'unavailable' }
  return { kind: 'detached', sha: sha.stdout.trim() }
}

export type RefsCarryingConfig = { readonly ok: true; readonly refs: readonly string[] } | { readonly ok: false }

/** No branch on this checkout carries the config the harness needs, or the
 *  branch on disk deleted it — look everywhere the pipeline's own commit
 *  history has ever put one. Capped at 20 candidates, and every candidate is
 *  confirmed with `ls-tree` so a branch that later deleted the config is
 *  excluded rather than falsely offered. Git pathspecs use a literal `/`,
 *  never `pathOps.join` — pathspec syntax is POSIX-shaped on every
 *  platform. */
const MAX_CANDIDATES = 20
const CONFIG_PATHSPEC = '.claude/port.config.json'

export async function refsCarryingConfig(git: GitRunner, cwd: string): Promise<RefsCarryingConfig> {
  const revList = await git(['rev-list', '--all', '--max-count=1', '--', CONFIG_PATHSPEC], cwd)
  if (!revList.ok) return { ok: false }
  const sha = revList.stdout.trim()
  if (sha === '') return { ok: true, refs: [] }

  const branches = await git(['branch', '-a', '--contains', sha, '--format=%(refname:short)'], cwd)
  if (!branches.ok) return { ok: false }
  const candidates = branches.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, MAX_CANDIDATES)

  const confirmed: string[] = []
  for (const ref of candidates) {
    const lsTree = await git(['ls-tree', '--name-only', ref, '--', CONFIG_PATHSPEC], cwd)
    if (lsTree.ok && lsTree.stdout.trim() !== '') confirmed.push(ref)
  }
  return { ok: true, refs: confirmed }
}

export type PermissionsState = 'missing' | 'empty' | 'populated'

interface SettingsShape {
  readonly permissions?: { readonly allow?: unknown }
}

/** Filesystem-only, never `git` — the same condition the cockpit's own
 *  startup preflight checks (#52): `permissions.allow` absent, unparseable,
 *  or unreadable all collapse to `missing`, since every one of them means
 *  "there is no usable allowlist on this checkout" from an operator's
 *  point of view. */
export async function permissionsState(root: string): Promise<PermissionsState> {
  const settingsPath = pathOps.join(root, '.claude', 'settings.json')
  const result = await readJsonFile<SettingsShape>(settingsPath)
  if (!result.ok) return 'missing'
  const allow = result.value.permissions?.allow
  if (!Array.isArray(allow)) return 'missing'
  return allow.length === 0 ? 'empty' : 'populated'
}
