// Joins `readWorktrees` for the one fact the script's JSON omits (`prunable`) — this directory
// calls no `git` itself; the join is the only reader.
import { node as defaultNode } from '@/main/platform/node'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import type { CommandResult, NodeRunner } from '@/types/platform'
import { readWorktrees } from '@/main/local/worktrees'
import type { AssertEqual } from '@/types/assert-type'
import type { GithubResolutionState, InspectedWorktree, PorcelainJoinState, ReclaimerFailureKind, WorktreesReport } from '@/types/reclaimer'
import { isReclaimableState } from '@/types/reclaimer'
import { parseNodeCommand } from '@/main/reclaimer/command'
import { describeCommandFailure } from '@/main/reclaimer/command-failure'
import { parseReportPayload } from '@/main/reclaimer/parse'
import type { ReadWorktreeReportParams } from '@/types/reclaimer'

// Fails to compile if a new `CommandResult` failure kind is added without `ReclaimerFailureKind` growing to match.
type CommandResultFailureKind = Exclude<CommandResult, { ok: true }>['kind']
type ReclaimerOwnFailureKind = 'not-configured' | 'unparseable-command' | 'unsupported-runner' | 'script-failed' | 'report-unparseable'
export const _kindsCoverCommandResult: AssertEqual<ReclaimerFailureKind, CommandResultFailureKind | ReclaimerOwnFailureKind> = true

// Two literals reaching in from the shipped script, pinned against its own copies by layer 1.
export const SCRIPT_FAIL_PREFIX = 'FAIL  '
export const GH_RESOLUTION_FAILED_SENTINEL = 'gh issueOrPullRequest resolution failed'

export type { NodeRunner }

function firstFailLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith(SCRIPT_FAIL_PREFIX))
  return (line ?? stderr.trim()).slice(0, 2000)
}

// Retries exactly once with `--offline` appended when the first attempt's stderr carries the sentinel.
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

  const tokenized = parseNodeCommand(params.worktreesCommand)
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

  // Indexed by pathOps.pathKey, never string equality, since case and separator differ on Windows.
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
    forcedActions: parsed.forcedActions,
    worktrees,
    orphanDirs: parsed.orphanDirs,
    registered: parsed.registered,
    byState: parsed.byState,
    githubResolution,
    porcelainJoin,
    readAt,
  }
}
