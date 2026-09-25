import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export type ClaudeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

/** 10s — `claude(['--version'])` is the only call site today (#97's
 *  `version.ts`), a single short-lived process with no network I/O, well
 *  under the platform layer's 30s default (`DEFAULT_TIMEOUT_MS` in
 *  `run.ts`). Overridable per call like every other `RunCommandOptions.timeoutMs`. */
const DEFAULT_CLAUDE_TIMEOUT_MS = 10_000

/** `claude(args, options)` — keeps `runCommand(` inside `main/platform/`
 *  (the `desktop-platform-layer` rail every other adapter already follows
 *  for `git`/`gh`/`node`), so `main/runtime/` never spawns a subprocess
 *  itself. */
export function claude(args: readonly string[], options: ClaudeOptions = {}): Promise<CommandResult> {
  return runCommand('claude', args, { timeoutMs: DEFAULT_CLAUDE_TIMEOUT_MS, ...options })
}
