// One copy of the session/agent label derivation (#87) — the sessions
// picker, the transcript header, and search all show the same string for the
// same session or agent, so this is the only place that decides it. No
// import here may reach a Node builtin or the Agent SDK, the same
// renderer-safe contract `shared/sessions/types.ts` already holds.
import type { AgentRecord, SessionRecord } from './types'

const LABEL_MAX = 80

/** `customTitle` → `summary` → `firstPrompt` → `(untitled session)`, cut at
 *  80 characters with an ellipsis — the ladder `renderer/src/sessions.ts`'s
 *  now-deleted `titleOf` held, and `main.ts`'s now-deleted `titleFor` reached
 *  for a second time under a different name. */
export function sessionLabel(session: SessionRecord): string {
  const raw = session.customTitle ?? session.summary ?? session.firstPrompt ?? '(untitled session)'
  return raw.length > LABEL_MAX ? `${raw.slice(0, LABEL_MAX)}…` : raw
}

/** `stage ?? agentType`, plus `#N` when the description named an item — the
 *  same computation `main.ts`'s `titleFor` held inline for its agent branch. */
export function agentLabel(agent: AgentRecord): string {
  const stage = agent.stage ?? agent.agentType
  return agent.itemNumber !== null ? `${stage} #${agent.itemNumber}` : stage
}
