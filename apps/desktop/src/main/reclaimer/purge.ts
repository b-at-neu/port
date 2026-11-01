// runPurge: drives `bin/worktrees.mjs purge --orphan <path> --json` for one confirmed path. No retry.
import { node as defaultNode } from '@/main/platform/node'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import type { RunPurgeParams, WorktreesPurgeResult } from '@/types/reclaimer'
import { parseNodeCommand } from '@/main/reclaimer/command'
import { describeCommandFailure } from '@/main/reclaimer/command-failure'
import { SCRIPT_FAIL_PREFIX } from '@/main/reclaimer/report'
import { parsePurgePayload } from '@/main/reclaimer/parse'

function firstFailLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith(SCRIPT_FAIL_PREFIX))
  return (line ?? stderr.trim()).slice(0, 2000)
}

export async function runPurge(params: RunPurgeParams): Promise<WorktreesPurgeResult> {
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
    return { ok: false, kind: 'unparseable-command', message: 'commands.worktrees could not be parsed as a plain command prefix.', readAt, call: null }
  }

  const args = [...tokenized.args, 'purge', '--orphan', params.path, '--json']
  const pathBasename = pathOps.basename(params.path)
  const result = await runNode(args, { cwd: params.repoRoot })

  // Exit 2 means the script ran and reported a refused or failed path in its own JSON.
  if (!result.ok) {
    if (result.kind === 'nonzero' && result.stdout.trim() !== '') {
      const parsed = parsePurgePayload(result.stdout)
      if (parsed.ok) return { ok: true, outcome: parsed.outcome, pathBasename, message: parsed.message, cause: parsed.cause, readAt, call: args }
    }
    if (result.kind === 'nonzero' && result.stderr.includes(SCRIPT_FAIL_PREFIX)) {
      return { ok: false, kind: 'script-failed', message: firstFailLine(result.stderr), readAt, call: args }
    }
    const { kind, message } = describeCommandFailure(result)
    return { ok: false, kind, message, readAt, call: args }
  }

  const parsed = parsePurgePayload(result.stdout)
  if (!parsed.ok) return { ok: false, kind: 'report-unparseable', message: parsed.message, readAt, call: args }
  return { ok: true, outcome: parsed.outcome, pathBasename, message: parsed.message, cause: parsed.cause, readAt, call: args }
}
