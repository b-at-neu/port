// The one place a bare StageAgent key becomes the SDK's `agent:` option value — the key of the inline `agents:` entry built from the bundled file, never typed a second way anywhere else.
import type { StageAgent } from '@/types/tick'

/** `apps/desktop/stage-prompts/agents/<stage>-agent.md`'s own frontmatter `name`, un-namespaced. A test reads those files' frontmatter and asserts both directions. */
export const STAGE_AGENT_NAMES: Readonly<Record<StageAgent, string>> = {
  plan: 'plan-agent',
  impl: 'impl-agent',
  review: 'review-agent',
  revise: 'revise-agent',
}
