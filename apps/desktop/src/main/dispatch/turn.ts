// #326: the two stage-dispatch prompt texts — no I/O, no SDK import.
import type { TickActionable } from '../../shared/tick/types'

/** Byte-identical to `plugins/port/skills/pipeline/SKILL.md`'s own
 *  "Dispatching" block — a pin (`scripts/checks/desktop-dispatch.ts`), since
 *  both the cockpit and this app's loop must send the exact same
 *  instruction to a stage agent regardless of which one dispatched it. */
export const DISPATCH_PROMPT = 'Run your pipeline stage for #<n>. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
export const REFRESH_PROMPT = 'Run your pipeline stage for pull request #<n> in refresh mode.'

/** `model` comes from `entry.config.models[agent]`; `prompt` comes from this
 *  function — `launch.ts`'s own `StageLaunchRequest.prompt` is filled from
 *  it, never re-derived at the launcher. */
export function promptFor(actionable: Pick<TickActionable, 'trigger' | 'number'>): string {
  const n = String(actionable.number)
  return actionable.trigger === 'refreshBranch' ? REFRESH_PROMPT.replace('<n>', n) : DISPATCH_PROMPT.replace('<n>', n)
}
