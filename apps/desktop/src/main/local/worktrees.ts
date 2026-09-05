// readWorktrees: parses `git worktree list --porcelain` into the app's own
// worktree model. Local-only (Decision 1) — no `gh` call, no item state, no
// removal; that stays `templates/worktrees.mjs`'s job and #79's join. Three
// batched `git` invocations per repository, independent of worktree count
// (Decision 3): one `worktree list --porcelain`, one `config --get-regexp`
// for every upstream at once, one `log --no-walk=unsorted` for every head at
// once.
import { git as defaultGit, parsePorcelainStanzas, pathOps as defaultPathOps } from '../platform'
import type { CommandResult, PathOps } from '../platform'
import type { AssertEqual } from '../../shared/assert-type'
import type { LocalFailureKind, WorktreeEntry, WorktreeProducer, WorktreesRead } from '../../shared/local/types'
import { correlate } from './correlate'

/** The injectable seam every function below takes instead of importing `git`
 *  directly — the same idiom `GhRunner` (`main/github/adapter.ts`) and
 *  `GitRunner` (`main/registry/harness.ts`) already use, so `worktrees.test.ts`
 *  runs against a fake runner and needs no real repository. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

export interface ReadWorktreesParams {
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly now?: () => Date
  /** Defaults to the host-bound singleton — injectable, the same idiom as
   *  `registry/store.ts`'s `dedupePaths`, so a win32-flavoured case
   *  (`git` emits `C:/Users/…` on Windows) is exercised on any host. */
  readonly pathOps?: PathOps
}

/** Fails to compile if a new `CommandResult` failure kind is added to the
 *  platform layer without `LocalFailureKind` (`shared/local/types.ts`)
 *  growing to match — the same pin `main/github/adapter.ts` establishes for
 *  `PipelineFailureKind`. */
type CommandResultFailureKind = Exclude<CommandResult, { ok: true }>['kind']
export const _kindsCoverCommandResult: AssertEqual<LocalFailureKind, CommandResultFailureKind | 'not-a-repository'> = true

function toLines(stdout: string): readonly string[] {
  const trimmed = stdout.replace(/\r?\n$/, '')
  return trimmed === '' ? [] : trimmed.split(/\r?\n/)
}

function describeFailure(result: Exclude<CommandResult, { ok: true }>): { kind: LocalFailureKind; message: string } {
  switch (result.kind) {
    case 'not-found':
      return { kind: 'not-found', message: `git not found on PATH (searched: ${result.searched.join(', ')})` }
    case 'cwd-missing':
      return { kind: 'cwd-missing', message: `working directory does not exist: ${result.cwd}` }
    case 'nonzero':
      // Exit 128 outside a repository, matching `gitRepoRoot`'s own mapping
      // (main/platform/git.ts) rather than a generic nonzero.
      if (result.code === 128) return { kind: 'not-a-repository', message: result.stderr.trim() || 'not a git repository' }
      return { kind: 'nonzero', message: result.stderr.trim() || `git exited with code ${result.code}` }
    case 'signalled':
      return { kind: 'signalled', message: `git was killed by signal ${result.signal}` }
    case 'timeout':
      return { kind: 'timeout', message: `git timed out after ${result.timeoutMs}ms` }
    case 'output-too-large':
      return { kind: 'output-too-large', message: `git output exceeded ${result.maxBytes} bytes` }
    case 'spawn-failed':
      return { kind: 'spawn-failed', message: result.message }
  }
}

const UPSTREAM_KEY_PATTERN = /^branch\.(.*)\.merge$/

/** Strips the `branch.` prefix and the *last* `.merge` suffix — never split
 *  on `.`, which would silently mis-key a branch name containing dots
 *  (`branch.release.1.merge`). The `.*` is greedy, so it backtracks to the
 *  final `.merge` in the key rather than the first. */
function parseUpstreamMap(lines: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) continue
    const key = line.slice(0, spaceIdx)
    const value = line.slice(spaceIdx + 1)
    const match = UPSTREAM_KEY_PATTERN.exec(key)
    const branchName = match?.[1]
    if (branchName !== undefined) map.set(branchName, value)
  }
  return map
}

/** `<sha> <subject>` per line — split on the first space only, since a
 *  subject may itself contain spaces. */
function parseSubjectMap(lines: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ')
    map.set(spaceIdx === -1 ? line : line.slice(0, spaceIdx), spaceIdx === -1 ? '' : line.slice(spaceIdx + 1))
  }
  return map
}

function producerOf(dirBasename: string): WorktreeProducer {
  if (/^impl-\d+$/.test(dirBasename)) return 'operator'
  if (/^agent-/.test(dirBasename)) return 'dispatched'
  return 'other'
}

interface RawEntry {
  readonly path: string
  readonly branch: string | null
  readonly head: string | null
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly lockReason: string | null
  readonly prunable: boolean
  readonly prunableReason: string | null
}

function stringOrNull(value: string | true | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function parseRawEntries(stdout: string, pathOps: PathOps): readonly RawEntry[] {
  return parsePorcelainStanzas(stdout).map((stanza) => {
    const branchRef = stringOrNull(stanza.get('branch'))
    return {
      path: pathOps.toNative(stanza.get('worktree') as string),
      branch: branchRef !== null ? branchRef.replace(/^refs\/heads\//, '') : null,
      head: stringOrNull(stanza.get('HEAD')),
      detached: stanza.has('detached'),
      bare: stanza.has('bare'),
      locked: stanza.has('locked'),
      lockReason: stanza.has('locked') ? stringOrNull(stanza.get('locked')) : null,
      prunable: stanza.has('prunable'),
      prunableReason: stanza.has('prunable') ? stringOrNull(stanza.get('prunable')) : null,
    }
  })
}

/** Local facts only, per the plan's field table — no `gh`, no item state, no
 *  removal decision. `#0` is never a correlation (see `correlate.ts`). */
export async function readWorktrees(params: ReadWorktreesParams): Promise<WorktreesRead> {
  const git = params.git ?? ((args, cwd) => defaultGit(args, { cwd }))
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const readAt = now().toISOString()

  const listResult = await git(['worktree', 'list', '--porcelain'], params.repoRoot)
  if (!listResult.ok) {
    const { kind, message } = describeFailure(listResult)
    return { ok: false, kind, message, readAt }
  }

  const rawEntries = parseRawEntries(listResult.stdout, pathOps)
  const mainPath = rawEntries[0]?.path ?? params.repoRoot

  // `git config --get-regexp` exits 1 when nothing matches — an empty
  // upstream set, never a failure of the whole read. Any other failure
  // kind is a real problem worth reporting, since it means the same `git`
  // that just answered `worktree list` could not answer this call.
  const upstreamResult = await git(['config', '--get-regexp', '^branch\\..*\\.merge'], params.repoRoot)
  let upstreamMap: ReadonlyMap<string, string>
  if (upstreamResult.ok) {
    upstreamMap = parseUpstreamMap(toLines(upstreamResult.stdout))
  } else if (upstreamResult.kind === 'nonzero' && upstreamResult.code === 1) {
    upstreamMap = new Map()
  } else {
    const { kind, message } = describeFailure(upstreamResult)
    return { ok: false, kind, message, readAt }
  }

  // A rung that could not run is not a rung that found nothing (ENGINEERING
  // §4) — a failing batch `git log --no-walk` degrades every entry relying
  // on it to `unresolved: 'subjects-unavailable'`, rather than failing the
  // whole read.
  const heads = [...new Set(rawEntries.map((entry) => entry.head).filter((head): head is string => head !== null))]
  let subjectMap: ReadonlyMap<string, string> = new Map()
  let subjectsAvailable = true
  if (heads.length > 0) {
    const logResult = await git(['log', '--no-walk=unsorted', '--format=%H %s', ...heads], params.repoRoot)
    if (logResult.ok) {
      subjectMap = parseSubjectMap(toLines(logResult.stdout))
    } else {
      subjectsAvailable = false
    }
  }

  const entries: WorktreeEntry[] = rawEntries.map((raw, index) => {
    const dirBasename = pathOps.basename(raw.path)
    const upstreamMergeRef = raw.branch !== null ? (upstreamMap.get(raw.branch) ?? null) : null
    const headSubject = raw.head !== null && subjectsAvailable ? (subjectMap.get(raw.head) ?? null) : null
    const correlation = correlate({ upstreamMergeRef, branch: raw.branch, dirBasename, headSubject })

    return {
      path: raw.path,
      isMain: index === 0,
      branch: raw.branch,
      head: raw.head,
      detached: raw.detached,
      bare: raw.bare,
      locked: raw.locked,
      lockReason: raw.lockReason,
      prunable: raw.prunable,
      prunableReason: raw.prunableReason,
      producer: producerOf(dirBasename),
      insideMain: pathOps.contains(mainPath, raw.path),
      correlation,
      unresolved: correlation !== null ? null : subjectsAvailable ? 'no-rung-matched' : 'subjects-unavailable',
    }
  })

  return { ok: true, mainPath, entries, subjectsAvailable, readAt }
}
