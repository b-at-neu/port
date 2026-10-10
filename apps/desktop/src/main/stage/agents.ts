// The one place a bare StageAgent key becomes the SDK's `agent:` option value — the plugin's own namespaced agent name, never typed a second way anywhere else.
import type { StageAgent } from '../../shared/tick/types'

/** `plugins/port/agents/<stage>-agent.md`'s own frontmatter `name`, namespaced by the plugin's manifest name (`port`). A test reads those files' frontmatter and asserts both directions. */
export const STAGE_AGENT_NAMES: Readonly<Record<StageAgent, string>> = {
  plan: 'port:plan-agent',
  impl: 'port:impl-agent',
  review: 'port:review-agent',
  revise: 'port:revise-agent',
}
