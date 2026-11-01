// runReclaim: drives `bin/worktrees.mjs reclaim --json`, the write half of
// report.ts's read. Passes --unlock/--force-dirty only path-scoped to one confirmed worktree; never --offline, no retry.
import { node as defaultNode } from '@/main/platform/node'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import type { WorktreesReclaimResult } from '@/types/reclaimer'
import { parseNodeCommand } from '@/main/reclaimer/command'
import { describeCommandFailure } from '@/main/reclaimer/command-failure'
import { SCRIPT_FAIL_PREFIX } from '@/main/reclaimer/report'
import { parseReclaimPayload } from '@/main/reclaimer/parse'
import type { RunReclaimParams } from '@/types/reclaimer'

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
  if (params.force !== null) {
    args.push('--path', params.force.path, '--max', '1')
    if (params.force.unlock) args.push('--unlock')
    if (params.force.forceDirty) args.push('--force-dirty')
  } else if (params.issue !== null) {
    args.push('--issue', String(params.issue))
  }

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
