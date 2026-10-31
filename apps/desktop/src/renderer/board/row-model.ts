// Pure per-row helpers for the Board's TicketRow and detail pane. Action
// state is passed in explicitly rather than read from a module global.
import { OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import { waitsOnYou } from '@/renderer/board/needs-you'
import type { BoardItemRow } from '@/types/board'
import { operatorJoinedOf as operatorJoinedOfRecords } from '@/renderer/board/stage-links'
import type { DispatchRecord } from '@/types/dispatch'
import type { AttachedAgent, AttachedSession, StageLabel } from '@/types/state'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { LabelRole } from '@/utils/labels/defaults'
import type { PhaseTone } from '@/types/components'
import { phaseTone } from '@/renderer/lib/phase-tone'
import type { ItemActionState, StageLinkTarget } from '@/types/board'
import { PHASE_NAMES } from '@/renderer/lib/phase'
import { actionRefusalNote, actionResultCopy, autoApprovingPhaseLabel, decisionButtonLabel, decisionRefusalNote, openPrButtonLabel, reviewPlanButtonLabel, stageAgentPhaseName } from '@/renderer/board/copy'

/** The current winning stage's own `LabelKey`, or `null` when `stage` resolves to nothing — the one place an item's `stages`/`stage` pair becomes a single phase key. */
export function stageKeyOf(stages: readonly StageLabel[], stage: LabelRole | null): LabelKey | null {
  return stages.find((label) => label.role === stage)?.key ?? null
}

// `waitingOnYou` mirrors board/sections.ts's own waiting-on-you predicate, so a row's
// section and its pulse can never disagree.
export function phaseToneFor(row: BoardItemRow): PhaseTone {
  const status = row.displayStatus.status
  return phaseTone({
    stageKey: row.stageLabel?.key ?? null,
    active: status === 'in-flight',
    waitingOnYou: waitsOnYou(row),
    operatorNeeded: status === 'interrupted' || status === 'stalled',
  })
}

/** A live stage session exists but the label still says the item is only queued — the `Dispatched` window before the agent's first label swap. */
export function isDispatchedRow(row: BoardItemRow): boolean {
  return row.liveStage !== null && row.item.status === 'waiting'
}

export function phaseLabelFor(row: BoardItemRow): string {
  if (row.displayStatus.status === 'interrupted') return 'Interrupted'
  if (row.autoApproving) return autoApprovingPhaseLabel()
  if (row.liveStage !== null && isDispatchedRow(row)) return stageAgentPhaseName(row.liveStage.agent)
  return row.stageLabel !== null ? (PHASE_NAMES[row.stageLabel.key] ?? row.stageLabel.key) : 'Unstaged'
}

/** Every (number, kind) the row's ticket answers to — its issue and its pull request. */
export function stageTargetsOf(row: BoardItemRow): readonly StageLinkTarget[] {
  return [row.ticket.issue, row.ticket.pullRequest].filter((member) => member !== null).map((member) => ({ number: member.number, kind: member.kind }))
}

/** `stage-links.ts`'s own `operatorJoinedOf`, re-exported for the row — `true` when any dispatch record for this ticket carries an operator join. */
export function operatorJoinedOf(records: readonly DispatchRecord[], row: BoardItemRow): boolean {
  return operatorJoinedOfRecords(records, stageTargetsOf(row))
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
    if (!availability.available && (availability.reason === 'cycle-cap' || availability.reason === 'rebase-decisions' || availability.reason === 'agent-live')) {
      return decisionRefusalNote(decision, availability.reason, row.ticket.ref.number)
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
  const n = String(row.ticket.ref.number)
  return `A ${name} is attached to #${n}. This app didn't dispatch it, so it can't stop it — stop it in the session that did, or run stop #${n} in the cockpit.`
}

export function actionNoteFor(row: BoardItemRow, state: ItemActionState | undefined): string | null {
  if (state?.kind === 'result') {
    const availability = row.actions[state.action]
    const base = actionResultCopy({
      action: state.action,
      number: row.ticket.ref.number,
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
  return ownershipNoteFor(row.actions, { number: row.ticket.ref.number, assignees: row.item.assignees })
}

type NextAction =
  | { readonly kind: 'review-plan'; readonly label: string }
  | { readonly kind: 'open-pr'; readonly label: string; readonly url: string }
  | { readonly kind: 'decision'; readonly label: string; readonly decision: OperatorDecision }

// First hit wins: review the plan, open a ready-to-merge pull request, then
// the first available decision.
export function nextActionFor(row: BoardItemRow): NextAction | null {
  if (row.item.kind === 'issue' && row.stageLabel?.key === 'planReview' && !row.autoApproving) {
    return { kind: 'review-plan', label: reviewPlanButtonLabel() }
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
