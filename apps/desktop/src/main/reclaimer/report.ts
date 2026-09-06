// readWorktreeReport: drives the shipped `templates/worktrees.mjs report
// --json` through `commands.worktrees`, classifies its outcome, and joins
// #77's `readWorktrees` for the one fact the script's JSON omits
// (`prunable`) — never a second classification implementation, and never a
// second `git worktree` caller (this directory calls no `git` itself; the
// join is the only reader).
import { node as defaultNode, pathOps as defaultPathOps } from '../platform'
import type { CommandResult, NodeOptions, PathOps } from '../platform'
import { readWorktrees } from '../local'
import type { WorktreesGitRunner } from '../local'
import type { AssertEqual } from '../../shared/assert-type'
import type { GithubResolutionState, InspectedWorktree, PorcelainJoinState, ReclaimerFailureKind, WorktreesReport } from '../../shared/reclaimer/types'
import { isReclaimableState } from '../../shared/reclaimer/types'
import { parseWorktreesCommand } from './command'
import { parseReportPayload } from './parse'

/** Fails to compile if a new `CommandResult` failure kind is added to the
 *  platform layer without `ReclaimerFailureKind`
 *  (`shared/reclaimer/types.ts`) growing to match — the same pin
 *  `main/local/worktrees.ts` establishes for `LocalFailureKind`. Five kinds
 *  are this adapter's own, layered above the platform layer's seven. */
type CommandResultFailureKind = Exclude<CommandResult, { ok: true }>['kind']
type ReclaimerOwnFailureKind = 'not-configured' | 'unparseable-command' | 'unsupported-runner' | 'script-failed' | 'report-unparseable'
export const _kindsCoverCommandResult: AssertEqual<ReclaimerFailureKind, CommandResultFailureKind | ReclaimerOwnFailureKind> = true

/** Two literals reaching in from the shipped script, pinned against
 *  `templates/worktrees.mjs`'s own copies by the `desktop-reclaimer` layer 1
 *  check — `die()`'s own `FAIL` prefix, and the sentence Decision 3's retry
 *  keys on. */
export const SCRIPT_FAIL_PREFIX = 'FAIL  '
export const GH_RESOLUTION_FAILED_SENTINEL = 'gh issueOrPullRequest resolution failed'

export type NodeRunner = (args: readonly string[], options: NodeOptions) => Promise<CommandResult>

export interface ReadWorktreeReportParams {
  readonly repoRoot: string
  /** `commands.worktrees` verbatim off the resolved config — `null` means
   *  the repository has not installed the reclamation script. */
  readonly worktreesCommand: string | null
  readonly runNode?: NodeRunner
  /** #77's own seam, injected here for the join (Decision 1). Omitted means
   *  the join is skipped and `porcelainJoin` reports `'unavailable'` — the
   *  report itself still succeeds. */
  readonly git?: WorktreesGitRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

function firstFailLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith(SCRIPT_FAIL_PREFIX))
  return (line ?? stderr.trim()).slice(0, 2000)
}

/** Maps a platform-layer failure straight through, never re-classifying —
 *  the same "carry the real kind" rule `main/local/worktrees.ts`'s
 *  `describeFailure` follows for `git`. */
function describeCommandFailure(result: Exclude<CommandResult, { ok: true }>): { kind: CommandResultFailureKind; message: string } {
  switch (result.kind) {
    case 'not-found':
      return { kind: 'not-found', message: `node not found on PATH (searched: ${result.searched.join(', ')})` }
    case 'cwd-missing':
      return { kind: 'cwd-missing', message: `working directory does not exist: ${result.cwd}` }
    case 'nonzero':
      return { kind: 'nonzero', message: result.stderr.trim() || `node exited with code ${result.code}` }
    case 'signalled':
      return { kind: 'signalled', message: `node was killed by signal ${result.signal}` }
    case 'timeout':
      return { kind: 'timeout', message: `node timed out after ${result.timeoutMs}ms` }
    case 'output-too-large':
      return { kind: 'output-too-large', message: `node output exceeded ${result.maxBytes} bytes` }
    case 'spawn-failed':
      return { kind: 'spawn-failed', message: result.message }
  }
}

/** Runs the reclaimer's `report --json` and returns whatever `result` came
 *  back, retrying exactly once with `--offline` appended when the first
 *  attempt's stderr carries the sentinel — never a second retry, whatever
 *  the retry itself returns. */
async function runReport(
  runNode: NodeRunner,
  args: readonly string[],
  repoRoot: string,
): Promise<{ result: CommandResult; githubResolution: GithubResolutionState }> {
  const first = await runNode(args, { cwd: repoRoot })
  if (first.ok || first.kind !== 'nonzero' || !first.stderr.includes(GH_RESOLUTION_FAILED_SENTINEL)) {
    return { result: first, githubResolution: 'resolved' }
  }
  const retried = await runNode([...args, '--offline'], { cwd: repoRoot })
  return { result: retried, githubResolution: 'unavailable' }
}

export async function readWorktreeReport(params: ReadWorktreeReportParams): Promise<WorktreesReport> {
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const runNode = params.runNode ?? defaultNode
  const readAt = now().toISOString()

  if (params.worktreesCommand === null) {
    return { ok: false, kind: 'not-configured', message: 'commands.worktrees is null — worktree hygiene is unavailable.', readAt }
  }

  const tokenized = parseWorktreesCommand(params.worktreesCommand)
  if (!tokenized.ok) {
    if (tokenized.kind === 'unsupported-runner') {
      return {
        ok: false,
        kind: 'unsupported-runner',
        token: tokenized.token,
        message: `commands.worktrees starts with '${tokenized.token}', which Port won't run — only a node prefix is supported.`,
        readAt,
      }
    }
    return { ok: false, kind: 'unparseable-command', message: 'commands.worktrees could not be parsed as a plain command prefix.', readAt }
  }

  const args = [...tokenized.args, 'report', '--json']
  const { result, githubResolution } = await runReport(runNode, args, params.repoRoot)

  if (!result.ok) {
    if (result.kind === 'nonzero' && result.stderr.includes(SCRIPT_FAIL_PREFIX)) {
      return { ok: false, kind: 'script-failed', message: firstFailLine(result.stderr), readAt }
    }
    const { kind, message } = describeCommandFailure(result)
    return { ok: false, kind, message, readAt }
  }

  const parsed = parseReportPayload(result.stdout, pathOps)
  if (!parsed.ok) {
    return { ok: false, kind: 'report-unparseable', message: parsed.message, readAt }
  }

  // Decision 1's join: #77's readWorktrees supplies `prunable`/`producer`,
  // indexed by pathOps.pathKey — never string equality, since case and
  // separator differ on Windows. A failed join degrades both fields to
  // `null` on every row rather than failing the whole report.
  let porcelainJoin: PorcelainJoinState = 'unavailable'
  const joined = new Map<string, { prunable: boolean; producer: InspectedWorktree['producer'] }>()
  if (params.git) {
    const localRead = await readWorktrees({ repoRoot: params.repoRoot, git: params.git, pathOps, now })
    if (localRead.ok) {
      porcelainJoin = 'joined'
      for (const entry of localRead.entries) {
        joined.set(pathOps.pathKey(entry.path), { prunable: entry.prunable, producer: entry.producer })
      }
    }
  }

  const worktrees: InspectedWorktree[] = parsed.worktrees.map((worktree) => {
    const match = joined.get(pathOps.pathKey(worktree.path))
    return {
      ...worktree,
      pathBasename: pathOps.basename(worktree.path),
      reclaimable: isReclaimableState(worktree.state),
      prunable: match?.prunable ?? null,
      producer: match?.producer ?? null,
    }
  })

  return {
    ok: true,
    mainRoot: parsed.mainRoot,
    integrationRef: parsed.integrationRef,
    worktrees,
    orphanDirs: parsed.orphanDirs,
    registered: parsed.registered,
    byState: parsed.byState,
    githubResolution,
    porcelainJoin,
    readAt,
  }
}
