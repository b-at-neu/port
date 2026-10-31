// What a registered repository looks like to the harness that would actually dispatch agents in it: the default branch at origin/HEAD, never the checked-out files. Every step degrades to a diagnostic rather than a failure.
import type { CommandResult, GitRunner } from '@/types/platform'
import type { RefRead } from '@/types/registry'

const DEFAULT_REF = 'refs/remotes/origin/HEAD'

function reasonOf(result: Exclude<CommandResult, { readonly ok: true }>): string {
  return 'stderr' in result && result.stderr.trim() !== '' ? result.stderr.trim() : result.kind
}

type DefaultRef = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** A missing `origin/HEAD` is restored once with `set-head --auto`; still missing means stage agents could not read their config either. */
async function resolveDefaultRef(git: GitRunner, root: string): Promise<DefaultRef> {
  const first = await git(['rev-parse', '--verify', '--quiet', DEFAULT_REF], root)
  if (first.ok) return { ok: true }

  const restored = await git(['remote', 'set-head', 'origin', '--auto'], root)
  if (!restored.ok) return { ok: false, message: reasonOf(restored) }

  const second = await git(['rev-parse', '--verify', '--quiet', DEFAULT_REF], root)
  return second.ok ? { ok: true } : { ok: false, message: 'origin/HEAD is not set' }
}

/** `git show origin/HEAD:<path>`; git's exit 128 for "does not exist" is `not-found`, any other failure `unreadable`. Git pathspecs use a literal `/`. */
export async function readAtDefaultRef(git: GitRunner, root: string, relPath: string): Promise<RefRead> {
  const ref = await resolveDefaultRef(git, root)
  if (!ref.ok) return { ok: false, kind: 'ref-unreadable', message: ref.message }

  const shown = await git(['show', `${DEFAULT_REF}:${relPath}`], root)
  if (shown.ok) return { ok: true, text: shown.stdout }
  if (shown.kind === 'nonzero' && shown.code === 128 && /does not exist|exists on disk, but not in/i.test(shown.stderr)) {
    return { ok: false, kind: 'not-found', message: `${relPath} is not on the default branch` }
  }
  return { ok: false, kind: 'unreadable', message: reasonOf(shown) }
}

/** `origin/dev`-style name of what `origin/HEAD` points at, or `null` when it cannot be resolved. */
export async function defaultRefName(git: GitRunner, root: string): Promise<string | null> {
  const named = await git(['symbolic-ref', '--short', DEFAULT_REF], root)
  if (!named.ok) return null
  const name = named.stdout.trim()
  return name === '' ? null : name
}

type RefsCarryingConfig = { readonly ok: true; readonly refs: readonly string[] } | { readonly ok: false }

/** Capped at 20 candidates, each confirmed with `ls-tree` so a branch that later deleted the config is excluded. Git pathspecs use a literal `/`, never `pathOps.join`. */
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

type PermissionsState = 'missing' | 'empty' | 'populated'

interface SettingsShape {
  readonly permissions?: { readonly allow?: unknown }
}

/** `permissions.allow` absent, unparseable, or unreadable on the default branch all collapse to `missing`. */
export function permissionsStateOf(read: RefRead): PermissionsState {
  if (!read.ok) return 'missing'
  let parsed: SettingsShape
  try {
    parsed = JSON.parse(read.text) as SettingsShape
  } catch {
    return 'missing'
  }
  const allow = parsed?.permissions?.allow
  if (!Array.isArray(allow)) return 'missing'
  return allow.length === 0 ? 'empty' : 'populated'
}
