// planTick — one RepositoryState to one TickReport. Pure: no gh, no timer, no write. This app
// computes the decision and the report; it never writes the escalation itself.
import type { PipelineItemKind } from '../../shared/github/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { TickActionable, TickBlind, TickClaim, TickHeld, TickHeldReason, TickObservation, TickReport } from '../../shared/tick/types'
import type { ClaimedItem, OccupiedEntry } from '../../../../../scripts/port-tick/contention'
import { gateCandidates } from '../../../../../scripts/port-tick/contention'
import type { Disposition } from '../../../../../scripts/port-tick/checks'
import { cycleCapExceeded, cycleGrantCount, mergeabilityRoute, refreshWins, zeroDiffGate } from '../../../../../scripts/port-tick/gates'
import type { DispatchLedger, RefreshMemo, UnknownStreaks } from './ledger'
import { RETRY_TRIGGER } from '../../../../../scripts/port-tick/liveness'
import { observationsOf } from './observe'
import { partitionOwnership } from '../../../../../scripts/port-tick/classify'
import { AGENT_FOR_IN_FLIGHT, AGENT_FOR_TRIGGER } from './routing'
import { autoApprovalsOf } from './auto-plan'

export interface PlanTickParams {
  readonly repository: RepositoryState
  readonly ledger: DispatchLedger
  /** This app's own process-scoped mergeability-UNKNOWN memo, read and written only by the
   *  `readyForReview` mergeability check below. */
  readonly unknownStreaks: UnknownStreaks
  /** Carried onto the report's own `nextTickAt`, never derived a second time here. */
  readonly nextDecisionAt: Date
  readonly now: () => Date
  /** Read from config per repository, never hardcoded. */
  readonly reviewCycleCap: number
  /** This repository's own live stage sessions, as descriptions — `[]` when none are live. A
   *  reset never fires against a session this app itself just launched. */
  readonly startedTasks: readonly string[]
  /** The app's own process-scoped refresh memo — read and written only by `observationsOf`'s refresh family. */
  readonly refreshMemo: RefreshMemo
  /** Read from config per repository, feeds the approval-withdrawal observation's `rollupVerdict` call. */
  readonly checkDispositions: Readonly<Record<string, Disposition>>
}

function emptyReport(repoId: RepoId, displayName: string, blind: TickBlind): TickReport {
  return { repoId, displayName, blind, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [] }
}

/** The winning `StageLabel`'s own key — `null` only when `item.stage` is `null`. A local copy
 *  rather than an import from `shared/actions/plan.ts`, since that module answers a different question. */
function stageKeyOf(item: Pick<ReconciledItem, 'stage' | 'stages'>): LabelKey | null {
  if (item.stage === null) return null
  return item.stages.find((label) => label.role === item.stage)?.key ?? null
}

/** Held reasons, first hit wins: unowned before other-operator before session-required. `contended`
 *  is the file-contention gate's own reason, applied afterward, never returned here. */
function heldReasonOf(item: ReconciledItem, unowned: ReadonlySet<number>, others: ReadonlySet<number>): Exclude<TickHeld['reason'], 'contended' | 'cycle-cap' | 'zero-diff'> | null {
  if (unowned.has(item.number)) return 'unowned'
  if (others.has(item.number)) return 'other-operator'
  if (item.sessionRequired) return 'session-required'
  return null
}

/** `TickActionable.cycle` — populated only for a `revise`/`review` candidate; `null` for every other agent. */
function cycleOf(item: ReconciledItem, cap: number): { readonly count: number; readonly cap: number } | null {
  return item.reviewCycleCount !== null ? { count: item.reviewCycleCount, cap } : null
}

/** Every item number carrying `key` among its (plural) `stages` — not filtered to the viewer or
 *  to `item.stage`'s own single winning role, since `refreshBranch` can sit alongside another trigger. */
function numbersCarrying(items: readonly ReconciledItem[], key: LabelKey): readonly number[] {
  return items.filter((item) => item.stages.some((label) => label.key === key)).map((item) => item.number)
}

/** The mergeability gate's own held reason, or `null` to proceed — `readyForReview` only.
 *  `UNKNOWN` holds once before dispatching on the second consecutive poll; `null` holds every poll. */
function mergeabilityHeld(item: ReconciledItem, repoId: RepoId, unknownStreaks: UnknownStreaks): TickHeldReason | null {
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

function occupiedSetOf(items: readonly ReconciledItem[]): readonly OccupiedEntry[] {
  const occupied: OccupiedEntry[] = []
  for (const item of items) {
    const key = stageKeyOf(item)
    if (key !== 'inProgress' && key !== 'prOpened') continue
    const label = item.stages.find((s) => s.key === key)?.name ?? key
    occupied.push({ item: item.number, label, paths: item.claimedFiles ?? [] })
  }
  return occupied
}

/** Splits into `held` (ownership/session-required, `contended` appended after) and `actionable`:
 *  ungated agents first, then structured `impl` survivors in fewest-conflicts-first order. */
function actionableAndHeld(
  items: readonly ReconciledItem[],
  viewer: string,
  concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number },
  reviewCycleCap: number,
  repoId: RepoId,
  unknownStreaks: UnknownStreaks,
): { readonly actionable: readonly TickActionable[]; readonly held: readonly TickHeld[] } {
  const held: TickHeld[] = []
  const refreshBranchNumbers = numbersCarrying(items, 'refreshBranch')
  const refreshingNumbers = numbersCarrying(items, 'refreshing')

  const triggerItems = items.filter(
    (item) =>
      item.stage === 'trigger' &&
      // Defensive: STAGE_PRECEDENCE already ranks in-flight above trigger, checked anyway.
      !item.stages.some((label) => label.role === 'in-flight'),
  )
  const { unowned, others } = partitionOwnership(triggerItems, viewer, (item) => item.assignees)
  const unownedNumbers = new Set(unowned.map((i) => i.number))
  const othersNumbers = new Set(others.map((i) => i.number))

  const occupiedSet = occupiedSetOf(items)

  const ungated: TickActionable[] = []
  const structuredCandidates: ClaimedItem[] = []
  const structuredMeta = new Map<number, { readonly kind: PipelineItemKind; readonly trigger: LabelKey }>()

  for (const item of triggerItems) {
    const trigger = stageKeyOf(item)
    if (trigger === null) continue

    const reason = heldReasonOf(item, unownedNumbers, othersNumbers)

    // A refreshBranch trigger co-present with another trigger label never wins stageKeyOf's own
    // first-match resolution, so this yields a second, independent entry for refreshBranch itself.
    if (trigger !== 'refreshBranch' && item.stages.some((label) => label.key === 'refreshBranch')) {
      if (reason !== null) {
        held.push({ number: item.number, kind: item.kind, trigger: 'refreshBranch', reason, contention: null, escalation: null })
      } else {
        ungated.push({ number: item.number, kind: item.kind, trigger: 'refreshBranch', agent: 'revise', unchecked: false, cycle: null })
      }
    }

    if (reason !== null) {
      held.push({ number: item.number, kind: item.kind, trigger, reason, contention: null, escalation: null })
      continue
    }
    const agent = AGENT_FOR_TRIGGER[trigger]
    if (agent === undefined) continue

    // The refresh-wins veto: a pull request already claimed by a refresh must never also be
    // dispatched to review or revision in the same tick.
    if (trigger === 'needsRevision' && refreshWins({ number: item.number, refreshBranch: refreshBranchNumbers, refreshing: refreshingNumbers }).action === 'veto') {
      held.push({ number: item.number, kind: item.kind, trigger, reason: 'refresh-wins', contention: null, escalation: null })
      continue
    }
    if (agent === 'review') {
      if (refreshWins({ number: item.number, refreshBranch: refreshBranchNumbers, refreshing: refreshingNumbers }).action === 'veto') {
        held.push({ number: item.number, kind: item.kind, trigger, reason: 'refresh-wins', contention: null, escalation: null })
        continue
      }
      const mergeHeld = mergeabilityHeld(item, repoId, unknownStreaks)
      if (mergeHeld !== null) {
        held.push({ number: item.number, kind: item.kind, trigger, reason: mergeHeld, contention: null, escalation: null })
        continue
      }
    }

    // The cycle-cap gate: unconditional, fires whatever the latest review said. The effective cap
    // folds in any operator-granted cycles.
    if (agent === 'revise' && cycleCapExceeded(item.reviews ?? undefined, reviewCycleCap, item.comments ?? undefined)) {
      held.push({
        number: item.number,
        kind: item.kind,
        trigger,
        reason: 'cycle-cap',
        contention: null,
        escalation: { kind: 'cycle-cap', count: item.reviewCycleCount ?? 0, cap: reviewCycleCap + cycleGrantCount(item.comments ?? undefined) },
      })
      continue
    }
    // The zero-diff gate: the one-time re-review permission is inherent in the label state itself.
    if (
      agent === 'review' &&
      zeroDiffGate({ reviews: item.reviews ?? undefined, comments: item.comments ?? undefined, headRefOid: item.headRefOid ?? '' }).action === 'escalate'
    ) {
      held.push({ number: item.number, kind: item.kind, trigger, reason: 'zero-diff', contention: null, escalation: { kind: 'zero-diff' } })
      continue
    }

    const cycle = cycleOf(item, agent === 'revise' ? reviewCycleCap + cycleGrantCount(item.comments ?? undefined) : reviewCycleCap)

    if (agent !== 'impl' || item.claimedFiles === null) {
      ungated.push({ number: item.number, kind: item.kind, trigger, agent, unchecked: agent === 'impl' && item.claimedFiles === null, cycle })
      continue
    }

    structuredCandidates.push({ item: item.number, paths: item.claimedFiles })
    structuredMeta.set(item.number, { kind: item.kind, trigger })
  }

  const gated = gateCandidates(structuredCandidates, occupiedSet, concurrency.sharedFiles, concurrency.overlapThreshold)

  const gatedActionable: TickActionable[] = gated.dispatch.map((number) => {
    const meta = structuredMeta.get(number)
    if (meta === undefined) throw new Error(`gateCandidates dispatched #${String(number)}, which was never a structured candidate`)
    // Always `null`: every structured candidate is an impl trigger over an issue.
    return { number, kind: meta.kind, trigger: meta.trigger, agent: 'impl', unchecked: false, cycle: null }
  })

  for (const h of gated.held) {
    const meta = structuredMeta.get(h.item)
    if (meta === undefined) throw new Error(`gateCandidates held #${String(h.item)}, which was never a structured candidate`)
    held.push({
      number: h.item,
      kind: meta.kind,
      trigger: meta.trigger,
      reason: 'contended',
      contention: { blocker: h.blocker, blockerStage: h.blockerLabel, depth: h.depth, paths: h.contendedPaths },
      escalation: null,
    })
  }

  return { actionable: [...ungated, ...gatedActionable], held }
}

function claimsOf(items: readonly ReconciledItem[], repoId: RepoId, ledger: DispatchLedger, startedTasks: readonly string[], readAt: string | null): readonly TickClaim[] {
  const claims: TickClaim[] = []
  for (const item of items) {
    if (item.stage !== 'in-flight') continue
    const inFlight = stageKeyOf(item)
    if (inFlight === null) continue

    if (item.sessionRequired) {
      claims.push({ number: item.number, kind: item.kind, inFlight, class: 'session-required', retryKey: null })
      continue
    }
    // Either source is enough to hold a reset back, so a reset never fires against an agent this
    // process itself just dispatched before the session scan has caught up to it.
    const agentForInFlight = AGENT_FOR_IN_FLIGHT[inFlight]
    const matchedByTask = agentForInFlight !== undefined && startedTasks.includes(`${agentForInFlight} #${String(item.number)}`)
    if (item.status === 'in-flight' || matchedByTask) {
      claims.push({ number: item.number, kind: item.kind, inFlight, class: 'matched', retryKey: null })
      continue
    }

    const result = ledger.observeUnmatched(repoId, item.number, readAt)
    const cls = result.class === 'reset' ? 'stalled-confirmed' : result.class
    // RETRY_TRIGGER's engine type is a bare Record<string, string>; this caller narrows it to LabelKey.
    const retryKey = cls === 'stalled-confirmed' ? ((RETRY_TRIGGER[inFlight] as LabelKey | undefined) ?? null) : null
    claims.push({ number: item.number, kind: item.kind, inFlight, class: cls, retryKey })
  }
  return claims
}

export function planTick(params: PlanTickParams): TickReport {
  const { repository, ledger, nextDecisionAt, now, reviewCycleCap, unknownStreaks, startedTasks, refreshMemo, checkDispositions } = params

  if (!repository.ok) {
    const blind: TickBlind = repository.reason === 'not-ready' ? { reason: 'not-ready' } : { reason: 'github-unavailable', message: repository.message }
    return emptyReport(repository.repoId, repository.displayName, blind)
  }

  if (repository.viewer === null) {
    return emptyReport(repository.repoId, repository.displayName, { reason: 'viewer-unknown' })
  }

  const githubEntry = repository.freshness.github
  const readAt = 'at' in githubEntry ? githubEntry.at : null
  if (readAt !== null) {
    const readAtMs = Date.parse(readAt)
    const ageMs = Number.isNaN(readAtMs) ? null : now().getTime() - readAtMs
    const threshold = SOURCE_BASE_INTERVAL_MS.github + STALE_GRACE_MS
    if (ageMs !== null && ageMs > threshold) {
      return emptyReport(repository.repoId, repository.displayName, { reason: 'stale-read', ageMs })
    }
  }

  const { actionable, held } = actionableAndHeld(repository.items, repository.viewer, repository.concurrency, reviewCycleCap, repository.repoId, unknownStreaks)
  const claims = claimsOf(repository.items, repository.repoId, ledger, startedTasks, readAt)
  const observations: readonly TickObservation[] = observationsOf({
    repoId: repository.repoId,
    items: repository.items,
    claims,
    held,
    viewer: repository.viewer,
    refreshMemo,
    checkDispositions,
  })

  return {
    repoId: repository.repoId,
    displayName: repository.displayName,
    blind: null,
    actionable,
    held,
    claims,
    disabledStages: repository.disabled,
    nextTickAt: nextDecisionAt.toISOString(),
    observations,
    autoApprovals: autoApprovalsOf(repository.items, repository.viewer),
  }
}
