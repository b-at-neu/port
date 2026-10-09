// One copy of the session/agent label derivation — the sessions picker, the transcript header, and search all show the same string, decided only here. No import here may reach a Node builtin or the Agent SDK.
import type { AgentRecord, SessionRecord } from './types'

const LABEL_MAX = 80

/** `customTitle` → `summary` → `firstPrompt` → `(untitled session)`, cut at 80 characters with an ellipsis. */
export function sessionLabel(session: SessionRecord): string {
  const raw = session.customTitle ?? session.summary ?? session.firstPrompt ?? '(untitled session)'
  return raw.length > LABEL_MAX ? `${raw.slice(0, LABEL_MAX)}…` : raw
}

/** `stage ?? agentType`, plus `#N` when the description named an item. */
export function agentLabel(agent: AgentRecord): string {
  const stage = agent.stage ?? agent.agentType
  return agent.itemNumber !== null ? `${stage} #${agent.itemNumber}` : stage
}
