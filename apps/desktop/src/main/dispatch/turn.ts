// #265: pure composition of the dispatcher session's own turns — the
// `Agent()` call specs a dispatch pass sends, and the two turn texts
// (`composeDispatchTurn`/`composeRelayTurn`) that tell the dispatcher
// session to make them verbatim. No I/O, no SDK import — `dispatcher.ts`
// is what actually calls `store.send`.
import type { AgentSummary } from '../../shared/hosting/types'
import type { StageAgent, TickActionable } from '../../shared/tick/types'

/** Byte-identical to `plugins/port/skills/pipeline/SKILL.md`'s own
 *  "Dispatching" block — a pin (`scripts/checks/desktop-dispatch.ts`), since
 *  both the cockpit and this app's dispatcher must send the exact same
 *  instruction to a stage agent regardless of which one dispatched it. */
export const DISPATCH_PROMPT = 'Run your pipeline stage for #<n>. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
export const REFRESH_PROMPT = 'Run your pipeline stage for pull request #<n> in refresh mode.'

/** The cockpit's own recommendation (`PIPELINE.md` → "Stages and models" →
 *  Cockpit row) — declared once, dispatching is mechanical. */
export const DISPATCHER_MODEL = 'haiku'

/** The dispatcher session's own `systemPrompt` append (`hosting/options.ts`'s
 *  `SessionOptionsRole`) — make only the calls named, verbatim; never do
 *  work of its own; never retry a failed call; report any failure in one
 *  line rather than attempting a workaround. */
export const DISPATCHER_INSTRUCTIONS =
  'You are this app\'s dispatcher. Every turn you receive names exactly which tool calls to make — Agent() calls to dispatch a pipeline stage, or a SendMessage() call to relay an answer to a stage agent still working on its task. Make exactly those calls, with their exact parameters, verbatim. Never make any other tool call and never do any work of your own — you are not the one implementing, reviewing, or planning anything. Never retry a call that fails; if a call fails, report the failure in one line and stop. When you have made every call named in the turn, reply DISPATCHED.'

export interface DispatchSpec {
  readonly description: string
  readonly subagentType: string
  readonly model: string
  readonly prompt: string
  readonly name: string
  readonly runInBackground: true
}

function promptFor(actionable: Pick<TickActionable, 'trigger' | 'number'>): string {
  const n = String(actionable.number)
  return actionable.trigger === 'refreshBranch' ? REFRESH_PROMPT.replace('<n>', n) : DISPATCH_PROMPT.replace('<n>', n)
}

/**
 * One candidate to one `Agent()` call spec, or `null` when the session's own
 * reported agent list (`capabilities.agents`, already namespace-stripped to
 * e.g. `'impl-agent'`) does not carry `'<agent>-agent'` — Claude Code
 * dropped it, and the dispatcher must never invent a call for an agent it
 * cannot actually address. `models` is the ready entry's own resolved
 * `config.models` (`Readonly<Record<StageAgent, string>>`).
 */
export function specFor(actionable: TickActionable, models: Readonly<Record<StageAgent, string>>, agents: readonly Pick<AgentSummary, 'name'>[]): DispatchSpec | null {
  const agentName = `${actionable.agent}-agent`
  if (!agents.some((a) => a.name === agentName)) return null
  const n = String(actionable.number)
  return {
    description: `${actionable.agent} #${n}`,
    subagentType: `port:${agentName}`,
    model: models[actionable.agent],
    prompt: promptFor(actionable),
    name: `${actionable.agent}-${n}`,
    runInBackground: true,
  }
}

/** The dispatch turn's own text — every `Agent({…})` call as literal JSON,
 *  all in one message, then `DISPATCHED`. `specs` is never empty here:
 *  `dispatcher.ts` only calls this once it has at least one. */
export function composeDispatchTurn(specs: readonly DispatchSpec[]): string {
  const calls = specs.map((spec) => `Agent(${JSON.stringify(spec)})`).join('\n')
  return `Make exactly these Agent calls, all in one message, with no other tool calls and no work of your own:\n\n${calls}\n\nThen reply DISPATCHED.`
}

/** The relay turn's own text — one `SendMessage` call, resuming an
 *  still-active background agent by the id `confirmStarted` matched it
 *  to. The exact field names here are one of the plan's own named risks
 *  ("SDK strings to verify in the live case") — a mismatch is one constant
 *  to fix in this file, never a reason to retry with a different shape at
 *  runtime. */
export function composeRelayTurn(agentId: string, text: string): string {
  return `Make exactly this call, with no other tool calls and no work of your own:\n\nSendMessage(${JSON.stringify({ agent_id: agentId, message: text })})\n\nThen reply DISPATCHED.`
}

/** `specFor`'s own companion for the owner line's "agents missing" UX state
 *  — the first candidate whose agent `specFor` refused, or `null` when every
 *  candidate resolved. Exported so `dispatcher.ts` can report exactly which
 *  stage agent Claude Code dropped, not just that dispatch is blocked. */
export function missingAgentOf(candidates: readonly TickActionable[], agents: readonly Pick<AgentSummary, 'name'>[]): StageAgent | null {
  const missing = candidates.find((c) => !agents.some((a) => a.name === `${c.agent}-agent`))
  return missing?.agent ?? null
}
