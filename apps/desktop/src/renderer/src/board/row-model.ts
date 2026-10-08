// Pure per-row helpers for the Board's TicketRow and detail pane. Action
// state is passed in explicitly rather than read from a module global.
import { OPERATOR_DECISIONS } from '../../../shared/actions/types'
import type { ActionAvailability, OperatorAction, OperatorDecision } from '../../../shared/actions/types'
import { needsYouReasonOf } from '../../../shared/board/needs-you'
import type { BoardItemRow } from '../../../shared/board/types'
import type { AttachedAgent, AttachedSession } from '../../../shared/state/types'
import type { PillStatus } from '../components/status-pill'
import type { ItemActionState } from './actions'
import { actionRefusalNote, actionResultCopy, answerQuestionButtonLabel, decisionButtonLabel, decisionRefusalNote, openPrButtonLabel, reviewPlanButtonLabel } from './copy'

// Mirrors board/sections.ts's own waiting-on-you predicate, so a row's
// section and its pill colour can never disagree.
export function pillStatusFor(row: BoardItemRow): PillStatus {
  if (needsYouReasonOf(row.stageLabel?.key) !== undefined || row.relay !== null) return 'attention'
  if (row.displayStatus.status === 'stalled') return 'danger'
  if (row.displayStatus.status === 'in-flight') return 'working'
  return 'idle'
}

export function agentSummaryOf(agents: readonly AttachedAgent[], sessions: readonly AttachedSession[]): string | null {
  const agent = agents.find((a) => a.activity !== 'dormant') ?? agents[0]
  if (agent) {
    const idleS = Math.round(agent.idleMs / 1000)
    const label = agent.stage ?? agent.agentType
    return agent.activity === 'active' ? `${label} · ${agent.model ?? 'unknown model'} · active ${idleS}s ago` : `${label} hasn't been active in a while.`
  }
  const session = sessions.find((s) => s.role === 'implement')
  if (session) {
    const idleS = Math.round(session.idleMs / 1000)
    return session.activity === 'active' ? `/port:implement session · active ${idleS}s ago` : '/port:implement session · idle'
  }
  return null
}

export function decisionNoteFor(row: BoardItemRow): string | null {
  for (const decision of OPERATOR_DECISIONS) {
    const availability = row.decisions[decision]
    if (!availability.available && (availability.reason === 'cycle-cap' || availability.reason === 'rebase-decisions')) {
      return decisionRefusalNote(decision, availability.reason, row.item.number)
    }
  }
  return null
}

export function ownershipNoteFor(actions: Readonly<Record<OperatorAction, ActionAvailability>>, item: { readonly number: number; readonly assignees: readonly string[] }): string | null {
  for (const action of ['pause', 'resume', 'retry', 'stop'] as const) {
    const availability = actions[action]
    if (!availability.available && (availability.reason === 'not-owned' || availability.reason === 'viewer-unknown')) {
      return actionRefusalNote(availability.reason, item)
    }
  }
  return null
}

export function stopAttachedAgentNote(row: BoardItemRow): string | null {
  const agent = row.item.agents[0]
  const name = agent !== undefined ? (agent.stage ?? agent.agentType) : (row.item.sessions.find((s) => s.role === 'implement') !== undefined ? '/port:implement session' : null)
  if (name === null) return null
  const n = String(row.item.number)
  return `A ${name} is attached to #${n}. This app didn't dispatch it, so it can't stop it — stop it in the session that did, or run stop #${n} in the cockpit.`
}

export function actionNoteFor(row: BoardItemRow, state: ItemActionState | undefined): string | null {
  if (state?.kind === 'result') {
    const availability = row.actions[state.action]
    const base = actionResultCopy({
      action: state.action,
      number: row.item.number,
      plan: availability.available ? availability.plan : null,
      currentStageName: row.stageLabel?.name ?? null,
      result: state.result,
      now: new Date(),
    })
    if (state.action === 'stop' && state.result.ok && state.result.outcome.kind === 'applied') {
      const attached = stopAttachedAgentNote(row)
      return attached !== null ? `${base} ${attached}` : base
    }
    return base
  }
  return ownershipNoteFor(row.actions, row.item)
}

export type NextAction =
  | { readonly kind: 'review-plan'; readonly label: string }
  | { readonly kind: 'answer-question'; readonly label: string }
  | { readonly kind: 'open-pr'; readonly label: string; readonly url: string }
  | { readonly kind: 'decision'; readonly label: string; readonly decision: OperatorDecision }

// First hit wins: review the plan, answer a pending question, open a
// ready-to-merge pull request, then the first available decision.
export function nextActionFor(row: BoardItemRow): NextAction | null {
  if (row.item.kind === 'issue' && row.stageLabel?.key === 'planReview') {
    return { kind: 'review-plan', label: reviewPlanButtonLabel() }
  }
  if (row.relay !== null) {
    return { kind: 'answer-question', label: answerQuestionButtonLabel() }
  }
  if (row.stageLabel?.key === 'approved') {
    return { kind: 'open-pr', label: openPrButtonLabel(), url: row.item.url }
  }
  for (const decision of OPERATOR_DECISIONS) {
    const availability = row.decisions[decision]
    if (availability.available) return { kind: 'decision', label: decisionButtonLabel(decision), decision }
  }
  return null
}
