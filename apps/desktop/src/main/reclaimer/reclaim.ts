// runReclaim: drives `bin/worktrees.mjs reclaim --json`, the write half of
// report.ts's read. Never passes --unlock/--force-dirty/--offline, no retry.
import { node as defaultNode } from '../platform/node'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { NodeRunner } from '../platform/node'
import type { PathOps } from '../platform/paths'
import type { WorktreesReclaimResult } from '../../shared/reclaimer/types'
import { parseNodeCommand } from './command'
import { describeCommandFailure } from './command-failure'
import { SCRIPT_FAIL_PREFIX } from './report'
import { parseReclaimPayload } from './parse'

export interface RunReclaimParams {
  readonly repoRoot: string
  /** `commands.worktrees` verbatim off the resolved config — `null` means
   *  the repository has not installed the reclamation script. */
  readonly worktreesCommand: string | null
  /** `null` reclaims every reclaimable candidate; a positive integer scopes
   *  the run to that ticket's own worktree (`--issue N`). */
  readonly issue: number | null
  readonly runNode?: NodeRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

function firstFailLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith(SCRIPT_FAIL_PREFIX))
  return (line ?? stderr.trim()).slice(0, 2000)
}

export async function runReclaim(params: RunReclaimParams): Promise<WorktreesReclaimResult> {
  const now = params.now ?? (() => new Date())
  const pathOps = params.pathOps ?? defaultPathOps
  const runNode = params.runNode ?? defaultNode
  const readAt = now().toISOString()

  if (params.worktreesCommand === null) {
    return { ok: false, kind: 'not-configured', message: 'commands.worktrees is null — worktree hygiene is unavailable.', readAt, call: null }
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
        call: null,
      }
    }
    return {
      ok: false,
      kind: 'unparseable-command',
      message: 'commands.worktrees could not be parsed as a plain command prefix.',
      readAt,
      call: null,
    }
  }

  const args = [...tokenized.args, 'reclaim', '--json']
  if (params.issue !== null) args.push('--issue', String(params.issue))

  const result = await runNode(args, { cwd: params.repoRoot })

  // A nonzero exit whose stdout still parses counts as a partial success.
  if (!result.ok) {
    if (result.kind === 'nonzero' && result.stdout.trim() !== '') {
      const parsed = parseReclaimPayload(result.stdout, pathOps)
      if (parsed.ok) return { ok: true, removed: parsed.removed, results: parsed.results, readAt, call: args }
    }
    if (result.kind === 'nonzero' && result.stderr.includes(SCRIPT_FAIL_PREFIX)) {
      return { ok: false, kind: 'script-failed', message: firstFailLine(result.stderr), readAt, call: args }
    }
    const { kind, message } = describeCommandFailure(result)
    return { ok: false, kind, message, readAt, call: args }
  }

  const parsed = parseReclaimPayload(result.stdout, pathOps)
  if (!parsed.ok) {
    return { ok: false, kind: 'report-unparseable', message: parsed.message, readAt, call: args }
  }

  return { ok: true, removed: parsed.removed, results: parsed.results, readAt, call: args }
}
