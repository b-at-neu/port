import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export type ClaudeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

// 10s — a single short-lived process with no network I/O, well under the platform layer's 30s default.
const DEFAULT_CLAUDE_TIMEOUT_MS = 10_000

export function claude(args: readonly string[], options: ClaudeOptions = {}): Promise<CommandResult> {
  return runCommand('claude', args, { timeoutMs: DEFAULT_CLAUDE_TIMEOUT_MS, ...options })
}
