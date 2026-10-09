import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export type NodeOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

// 60s — a `report --json` run is a `gh api graphql` round trip plus two `git` calls per worktree.
const DEFAULT_NODE_TIMEOUT_MS = 60_000

export function node(args: readonly string[], options: NodeOptions = {}): Promise<CommandResult> {
  return runCommand('node', args, { timeoutMs: DEFAULT_NODE_TIMEOUT_MS, ...options })
}

export type NodeRunner = (args: readonly string[], options: NodeOptions) => Promise<CommandResult>
