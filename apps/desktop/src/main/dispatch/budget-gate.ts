// #293: runs the shipped `bin/budget.mjs` through `commands.budget` and
// classifies its outcome into values the dispatcher can report — never a
// throw, and an absent signal is never read as a passing one. Every call
// tokenizes `entry.config.commands.budget` with `parseNodeCommand` (the same
// rail `commands.worktrees` already goes through, `main/reclaimer/`) and
// runs `node <tokenized args…> <mode args…>` with `cwd: entry.path`, since
// the script resolves its own root from the working directory.
import { node as defaultNode } from '../platform'
import type { CommandResult, NodeOptions } from '../platform'
import { parseNodeCommand, SCRIPT_FAIL_PREFIX } from '../reclaimer'
import type { ReadyEntry } from '../actions'
import type { TickActionable } from '../../shared/tick/types'
import { dispatchArgs, OUTDATED_SCRIPT_SENTINEL, parseSweepLine, parseVerdict, resetArgs, sweepArgs } from './budget'
import type { BudgetVerdict } from './budget'

export type NodeRunner = (args: readonly string[], options: NodeOptions) => Promise<CommandResult>

/** `unavailable`: the script can't be run at all, or is too old to accept
 *  `--session` — both fail the whole repository's gate, since the ceiling
 *  is unenforceable either way. `failed`: the script ran but exited non-zero
 *  for some other reason (its own `FAIL` line, when one exists). */
export type BudgetGateFailure = { readonly ok: false; readonly kind: 'unavailable' | 'failed'; readonly message: string }

export type BudgetResetResult = { readonly ok: true } | BudgetGateFailure
export type BudgetCheckResult = { readonly ok: true; readonly verdict: BudgetVerdict; readonly line: string } | BudgetGateFailure

/** Never a `BudgetGateFailure` — a sweep failure must never block dispatch,
 *  only report it (ENGINEERING §4: the over-counting direction is the one
 *  this rail prefers). `line` is read from stdout even when the run itself
 *  failed, because a ledger-flush failure still prints the session clause
 *  first. */
export interface BudgetSweepResult {
  readonly line: string | null
  readonly problem: string | null
}

export interface BudgetGate {
  readonly reset: (entry: ReadyEntry) => Promise<BudgetResetResult>
  readonly sweep: (entry: ReadyEntry, sets: { readonly live: readonly string[]; readonly completed: readonly string[] }) => Promise<BudgetSweepResult>
  readonly check: (entry: ReadyEntry, candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'>, model: string) => Promise<BudgetCheckResult>
}

function firstFailLine(stderr: string): string | null {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith(SCRIPT_FAIL_PREFIX))
  return line === undefined ? null : line.slice(0, 2000)
}

/** Mirrors `main/reclaimer/report.ts`'s own `describeCommandFailure` — a
 *  platform-layer failure carrying no `stderr` at all (`not-found`,
 *  `cwd-missing`, `output-too-large`, `spawn-failed`) is described from its
 *  own fields rather than reading a field the type does not guarantee. */
function describePlatformFailure(result: Exclude<CommandResult, { ok: true }>): string {
  switch (result.kind) {
    case 'not-found':
      return `node not found on PATH (searched: ${result.searched.join(', ')})`
    case 'cwd-missing':
      return `working directory does not exist: ${result.cwd}`
    case 'nonzero':
      return result.stderr.trim() || `node exited with code ${String(result.code)}`
    case 'signalled':
      return `node was killed by signal ${result.signal}`
    case 'timeout':
      return `node timed out after ${String(result.timeoutMs)}ms`
    case 'output-too-large':
      return `node output exceeded ${String(result.maxBytes)} bytes`
    case 'spawn-failed':
      return result.message
  }
}

/** The owner line's own "Script unusable" copy (plan's **UX states**) —
 *  assembled here, where the failure is classified, so `ownerLineCopy` stays
 *  a generic `⏸ Dispatch: this app, but not dispatching — ${message}`. */
function unavailableMessage(reason: string): string {
  return `commands.budget can't run (${reason}). Fix it in .claude/port.config.json, or release dispatch to hand it back to the cockpit.`
}

/** The owner line's own "Script predates --session" copy, same reasoning. */
const OUTDATED_MESSAGE =
  "this repository's budget script is older than this app needs. Re-copy plugins/port/bin/budget.mjs over it (/port:init offers to), or release dispatch."

interface RunOk {
  readonly ok: true
  readonly stdout: string
  readonly stderr: string
}
interface RunFailure {
  readonly ok: false
  readonly kind: 'unavailable' | 'failed'
  readonly message: string
  /** The raw stdout a 'nonzero' exit still produced — `null` for every
   *  other failure, where no process output exists to read. */
  readonly stdout: string | null
}

async function runBudget(entry: ReadyEntry, modeArgs: readonly string[], runNode: NodeRunner): Promise<RunOk | RunFailure> {
  const command = entry.config.commands.budget
  if (command === null) {
    return { ok: false, kind: 'unavailable', message: unavailableMessage('commands.budget is not configured'), stdout: null }
  }

  const tokenized = parseNodeCommand(command)
  if (!tokenized.ok) {
    const reason =
      tokenized.kind === 'unsupported-runner'
        ? `starts with '${tokenized.token}', which Port won't run — only a node prefix is supported`
        : 'could not be parsed as a plain command prefix'
    return { ok: false, kind: 'unavailable', message: unavailableMessage(reason), stdout: null }
  }

  const result = await runNode([...tokenized.args, ...modeArgs], { cwd: entry.path })
  if (result.ok) return { ok: true, stdout: result.stdout, stderr: result.stderr }

  if (result.kind === 'nonzero') {
    const failLine = firstFailLine(result.stderr)
    if (failLine !== null && failLine.includes(OUTDATED_SCRIPT_SENTINEL)) {
      return { ok: false, kind: 'unavailable', message: OUTDATED_MESSAGE, stdout: result.stdout }
    }
    return { ok: false, kind: 'failed', message: failLine ?? describePlatformFailure(result), stdout: result.stdout }
  }
  return { ok: false, kind: 'failed', message: describePlatformFailure(result), stdout: null }
}

export function createBudgetGate(deps: { readonly runNode?: NodeRunner } = {}): BudgetGate {
  const runNode = deps.runNode ?? defaultNode

  return {
    async reset(entry) {
      const run = await runBudget(entry, resetArgs(), runNode)
      if (!run.ok) return { ok: false, kind: run.kind, message: run.message }
      return { ok: true }
    },

    async sweep(entry, sets) {
      const run = await runBudget(entry, sweepArgs(sets), runNode)
      if (run.ok) return { line: parseSweepLine(run.stdout), problem: null }
      return { line: run.stdout !== null ? parseSweepLine(run.stdout) : null, problem: run.message }
    },

    async check(entry, candidate, model) {
      const run = await runBudget(entry, dispatchArgs(candidate, model), runNode)
      if (!run.ok) return { ok: false, kind: run.kind, message: run.message }
      const parsed = parseVerdict(run.stdout)
      if (parsed === null) {
        const message = firstFailLine(run.stderr) ?? `unrecognized budget dispatch output: ${run.stdout.split('\n')[0] ?? ''}`
        return { ok: false, kind: 'failed', message }
      }
      return { ok: true, verdict: parsed.verdict, line: parsed.line }
    },
  }
}
