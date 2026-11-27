// Pure: the per-ticket helpers `planTick` composes — which half a ticket acts on, the shared entry fields, and the hold reasons.
import type { IntegrationChecks, PipelineItemKind } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import type { TickHeld, TickHeldReason, UnknownStreaks } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import type { Stage, Ticket } from '@/utils/pipeline/ticket'
import { integrationRedGate, mergeabilityRoute } from '@/utils/pipeline/gates'

export type TrackedReconciled = ReconciledItem & { readonly ticket: Ticket }

const PR_STAGES: readonly Stage[] = ['review', 'revise', 'refresh', 'merge']

/** A ticket is decided once, on the half it acts on: the issue for plan and implement, the pull request from review on. */
export function actsOn(item: ReconciledItem): item is TrackedReconciled {
  const { ticket } = item
  if (ticket === null) return false
  if (ticket.pr !== null && PR_STAGES.includes(ticket.stage)) return item.kind === 'pull-request' && item.number === ticket.pr.number
  return item.kind === 'issue' && item.number === ticket.ticket
}

/** The fields every actionable, held and claim entry of one ticket shares. */
export function entryOf(item: TrackedReconciled): { readonly number: number; readonly kind: PipelineItemKind; readonly stage: Stage } {
  return { number: item.number, kind: item.kind, stage: item.ticket.stage }
}

/** Held reasons, first hit wins: unowned before other-operator before session-required. `contended` is the file-contention gate's own reason, applied afterward, never returned here. */
export function heldReasonOf(
  item: ReconciledItem,
  unowned: ReadonlySet<number>,
  others: ReadonlySet<number>,
  holdSessionRequired: boolean,
): Exclude<TickHeld['reason'], 'contended' | 'cycle-cap' | 'zero-diff' | 'check-hold' | 'integration-red' | 'integration-green'> | null {
  if (unowned.has(item.number)) return 'unowned'
  if (others.has(item.number)) return 'other-operator'
  if (holdSessionRequired && item.sessionRequired) return 'session-required'
  return null
}

/** The mergeability gate's own held reason, or `null` to proceed — a review only. `UNKNOWN` holds once before dispatching on the second consecutive poll; `null` holds every poll. */
export function mergeabilityHeld(item: ReconciledItem, repoId: RepoId, unknownStreaks: UnknownStreaks): TickHeldReason | null {
  const mergeable = item.mergeable
  if (mergeable === 'CONFLICTING') {
    unknownStreaks.clear(repoId, item.number)
    return 'conflicting'
  }
  if (mergeable === 'UNKNOWN') {
    const route = mergeabilityRoute(mergeable, unknownStreaks.get(repoId, item.number))
    if (route.action === 'hold') {
      unknownStreaks.set(repoId, item.number, route.unknownStreak)
      return 'mergeability-unknown'
    }
    unknownStreaks.clear(repoId, item.number)
    return null
  }
  if (mergeable === null) return 'mergeability-unknown'
  unknownStreaks.clear(repoId, item.number) // 'MERGEABLE'
  return null
}

/** When the ticket last waited on a person at a stage that can only be an escalation (plan and merge wait on approvals) — a plain unblock leaves no comment, so the gates read the history. */
export function escalatedAtOf(ticket: Ticket): string[] {
  return ticket.history.filter((event) => event.to?.status === 'waiting-on-you' && event.to.stage !== 'plan' && event.to.stage !== 'merge').map((event) => event.at)
}

/** The integration-red gate's held entry, or `null` to proceed. `refresh` is held as `integration-green` so `observe.ts` hands it to the refresh path; an unreadable `integrationChecks` holds rather than refreshes. */
export function integrationRedHeld(item: TrackedReconciled, integrationChecks: IntegrationChecks | null, now: Date): TickHeld | null {
  const gate = integrationRedGate({
    comments: item.comments ?? undefined,
    headRefOid: item.headRefOid ?? '',
    integration: integrationChecks === null ? null : new Map(Object.entries(integrationChecks)),
    now: now.toISOString(),
    escalatedAt: escalatedAtOf(item.ticket),
  })
  if (gate.action === 'none' || gate.facts === undefined) return null
  const base = { ...entryOf(item), contention: null }
  if (gate.action === 'refresh') return { ...base, reason: 'integration-green', escalation: null }
  const { checks, state, escalateAt } = gate.facts
  return { ...base, reason: 'integration-red', escalation: { kind: 'integration-red', checks, state, escalateAt: escalateAt ?? null, expired: gate.action === 'escalate' } }
}
