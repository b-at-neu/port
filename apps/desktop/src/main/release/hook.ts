// Runs `release.postPublishHook` once through `platform/node` — never retried, since the release has already shipped.
import { node as defaultNode } from '@/main/platform/node'
import type { CommandResult, NodeRunner } from '@/types/platform'
import type { HookOutcome } from '@/types/release'
import { parseNodeCommand } from '@/main/reclaimer/command'

const HOOK_TIMEOUT_MS = 5 * 60_000

interface RunHookParams {
  readonly command: string | null
  readonly cwd: string
  readonly runNode?: NodeRunner
}

function failureOf(result: Exclude<CommandResult, { ok: true }>): HookOutcome {
  if (result.kind === 'nonzero') return { kind: 'failed', exitCode: result.code, stderr: result.stderr }
  if (result.kind === 'timeout' || result.kind === 'signalled') return { kind: 'failed', exitCode: null, stderr: result.stderr }
  if (result.kind === 'not-found') return { kind: 'unrunnable', message: 'node was not found on PATH.' }
  if (result.kind === 'cwd-missing') return { kind: 'unrunnable', message: `The working directory does not exist: ${result.cwd}` }
  if (result.kind === 'spawn-failed') return { kind: 'unrunnable', message: result.message }
  return { kind: 'failed', exitCode: null, stderr: `The hook printed more than ${String(result.maxBytes)} bytes.` }
}

/** `skipped` for a null hook, `unrunnable` for anything that is not a plain `node` command. */
export async function runPostPublishHook(params: RunHookParams): Promise<HookOutcome> {
  if (params.command === null) return { kind: 'skipped' }
  const tokenized = parseNodeCommand(params.command)
  if (!tokenized.ok) {
    return { kind: 'unrunnable', message: tokenized.kind === 'unsupported-runner' ? `Port only runs a node command, and this one starts with '${tokenized.token}'.` : 'The command could not be parsed as a plain command.' }
  }
  const runNode = params.runNode ?? defaultNode
  const result = await runNode(tokenized.args, { cwd: params.cwd, timeoutMs: HOOK_TIMEOUT_MS })
  return result.ok ? { kind: 'ok', stdout: result.stdout } : failureOf(result)
}
