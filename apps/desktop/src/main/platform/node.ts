import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export type NodeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

/** 60s, above the platform layer's 30s default (`DEFAULT_TIMEOUT_MS` in
 *  `run.ts`) — one `report --json` run is a `gh api graphql` round trip plus
 *  two `git` calls per worktree (#86's reclaimer join), a different budget
 *  from a single `git`/`gh` call. Overridable per call like every other
 *  `RunCommandOptions.timeoutMs`. */
const DEFAULT_NODE_TIMEOUT_MS = 60_000

/** `node(args, options)` — keeps `runCommand(` inside `main/platform/`
 *  (the `desktop-platform-layer` rail every other adapter already follows
 *  for `git`/`gh`), so `main/reclaimer/` never spawns a subprocess itself. */
export function node(args: readonly string[], options: NodeOptions = {}): Promise<CommandResult> {
  return runCommand('node', args, { timeoutMs: DEFAULT_NODE_TIMEOUT_MS, ...options })
}
