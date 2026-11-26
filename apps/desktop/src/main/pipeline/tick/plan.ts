import type { UnknownStreaks, RefreshMemo, RerunMemo, ForceDispatch } from '@/types/tick'

// planTick — one RepositoryState to one TickReport. Pure: no gh, no timer, no write. This app
// computes the decision and the report; it never writes the escalation itself.
import type { IntegrationChecks, PipelineItemKind } from '@/types/github'
import type { RepoId } from '@/utils/repos'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '@/types/board'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import type { EndedStage, TickActionable, TickBlind, TickHeld, TickObservation, TickReport } from '@/types/tick'
import type { ClaimedItem, OccupiedEntry } from '@/utils/pipeline/contention'
import { gateCandidates } from '@/utils/pipeline/contention'
import type { Disposition } from '@/utils/pipeline/checks'
import { zeroDiffChecksOf } from '@/utils/pipeline/checks'
import { cycleGrantCount, zeroDiffGate } from '@/utils/pipeline/gates'
import { stageNameOf, stageRowOf } from '@/utils/pipeline/stages'
import type { Run, Stage } from '@/utils/pipeline/ticket'
import { observationsOf } from '@/main/pipeline/tick/observe'
import { adoptionsOf, heldVerdictAdoption, openPullRequestAdoption } from '@/main/pipeline/tick/adopt'
import { partitionOwnership } from '@/utils/pipeline/classify'
import { autoApprovalsOf } from '@/main/pipeline/tick/auto-plan'
import { repairsOf } from '@/main/pipeline/tick/repair'
import { claimsOf } from '@/main/pipeline/tick/claims'
import { actsOn, entryOf, escalatedAtOf, heldReasonOf, integrationRedHeld, mergeabilityHeld } from '@/main/pipeline/tick/holds'
import type { TrackedReconciled } from '@/main/pipeline/tick/holds'

interface PlanTickParams {
  readonly repository: RepositoryState
  /** The runs the ticket holding this item carries, which the stall ladder reads. `undefined` reads as none, so no claim is ever reset. */
  readonly runsOf?: (repoId: RepoId, kind: PipelineItemKind, number: number) => readonly Run[]
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
  /** `false` exactly when this app owns the repository and dispatches stage sessions itself — `SESSION REQUIRED` then holds nothing: `heldReasonOf` skips the `session-required` rung and `claimsOf` skips the `session-required` class. `true` is the default. */
  readonly holdSessionRequired: boolean
  /** App-owned repositories only: this repository's own live and interrupted stage sessions, as `${agent} #${number}` descriptions. `null`/`undefined` (unowned) leaves `item.status`/`startedTasks` to decide. Non-null ignores `item.status` entirely: a `live` claim is `matched`, an `interrupted` one is `interrupted`, anything else goes straight to the stall ladder. */
  readonly stageLiveness?: { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null
  /** This app's own ended stage-session records for this repository, newest per number — `main/pipeline/tick/repair.ts`'s session-shape evidence. `undefined`/`[]` is byte-identical: no session shape ever fires. */
  readonly endedStages?: readonly EndedStage[]
  /** The Needs-you "Dispatch anyway" override. `undefined` behaves exactly as today: no candidate ever bypasses the contention gate. */
  readonly forceDispatch?: ForceDispatch
  /** The head each pull request's failed checks were last re-run on. `undefined` never re-runs a check. */
  readonly rerunMemo?: RerunMemo
}

function emptyReport(repoId: RepoId, displayName: string, blind: TickBlind): TickReport {
  return { repoId, displayName, blind, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [] }
}

/** `TickActionable.cycle` — populated only for a `revise`/`review` candidate; `null` for every other agent. */
function cycleOf(item: ReconciledItem, cap: number): { readonly count: number; readonly cap: number } | null {
  return item.reviewCycleCount !== null ? { count: item.reviewCycleCount, cap } : null
}

/** Tickets holding the repository's working slot: an implementation running, or a pull request open. One entry per ticket, read off its issue half. */
function occupiedSetOf(items: readonly ReconciledItem[]): readonly OccupiedEntry[] {
  const occupied: OccupiedEntry[] = []
  for (const item of items) {
    const { ticket } = item
    if (item.kind !== 'issue' || ticket === null) continue
    if (!((ticket.stage === 'implement' && ticket.status.kind === 'running') || ticket.pr !== null)) continue
    occupied.push({ item: item.number, label: stageNameOf(ticket), paths: item.claimedFiles ?? [] })
  }
  return occupied
}

interface Concurrency {
  readonly sharedFiles: readonly string[]
  readonly overlapThreshold: number
}

interface TriggerParams {
  readonly items: readonly ReconciledItem[]
  readonly viewer: string
  readonly concurrency: Concurrency
  readonly reviewCycleCap: number
  readonly repoId: RepoId
  readonly unknownStreaks: UnknownStreaks
  readonly holdSessionRequired: boolean
  readonly forceDispatch: ForceDispatch | undefined
  readonly checkDispositions: Readonly<Record<string, Disposition>>
  readonly now: Date
  readonly integrationChecks: IntegrationChecks | null
}

/** The review-only gates, first hit wins: mergeability, integration-red, a verdict already on the head, then zero-diff. */
function reviewGate(item: TrackedReconciled, p: TriggerParams): { readonly held: TickHeld } | { readonly adoption: TickObservation } | null {
  const entry = { ...entryOf(item), contention: null }
  const mergeHeld = mergeabilityHeld(item, p.repoId, p.unknownStreaks)
  if (mergeHeld !== null) return { held: { ...entry, reason: mergeHeld, escalation: null } }
  const redHeld = integrationRedHeld(item, p.integrationChecks, p.now)
  if (redHeld !== null) return { held: redHeld }
  const adoption = heldVerdictAdoption(item)
  if (adoption !== null) return { adoption }
  // A null rollup was never selected, so the gate gets no check input and escalates.
  const checks = item.checkRollup === null ? undefined : zeroDiffChecksOf(item.checkRollup, p.checkDispositions, p.now.toISOString())
  const gate = zeroDiffGate({ reviews: item.reviews ?? undefined, comments: item.comments ?? undefined, headRefOid: item.headRefOid ?? '', checks, escalatedAt: escalatedAtOf(item.ticket) })
  // Only the per-head review cap (a second review of one head) is held; any other zero-diff result gets one more review.
  if (gate.action === 'escalate' && gate.reason === 'sha-cap') return { held: { ...entry, reason: 'zero-diff', escalation: { kind: 'zero-diff' } } }
  if (gate.action === 'hold-checks' && gate.facts !== undefined) {
    return { held: { ...entry, reason: 'check-hold', escalation: { kind: 'check-hold', checks: gate.facts.checks, state: gate.facts.state, escalateAt: gate.facts.escalateAt ?? null } } }
  }
  return null
}

/** Splits into `held` (ownership/session-required, `contended` appended after) and `actionable`:
 *  ungated agents first, then structured `impl` survivors in fewest-conflicts-first order. */
function actionableAndHeld(p: TriggerParams): { readonly actionable: readonly TickActionable[]; readonly held: readonly TickHeld[]; readonly adoptions: readonly TickObservation[] } {
  const { items, viewer, concurrency, reviewCycleCap, repoId, holdSessionRequired, forceDispatch } = p
  const held: TickHeld[] = []
  const adoptions: TickObservation[] = []

  const triggerItems = items.filter((item): item is TrackedReconciled => actsOn(item) && item.ticket.status.kind === 'queued' && stageRowOf(item.ticket).agent !== null)
  const { unowned, others } = partitionOwnership(triggerItems, viewer, (item) => item.assignees)
  const unownedNumbers = new Set(unowned.map((i) => i.number))
  const othersNumbers = new Set(others.map((i) => i.number))

  const occupiedSet = occupiedSetOf(items)

  const ungated: TickActionable[] = []
  const structuredCandidates: ClaimedItem[] = []
  const structuredMeta = new Map<number, { readonly kind: PipelineItemKind; readonly stage: Stage; readonly trigger: TickActionable['trigger'] }>()

  for (const item of triggerItems) {
    const entry = entryOf(item)
    const { stage } = entry
    const agent = stageRowOf(item.ticket).agent
    if (agent === null) continue
    const heldEntry = { ...entry, contention: null, escalation: null }

    const reason = heldReasonOf(item, unownedNumbers, othersNumbers, holdSessionRequired)
    if (reason !== null) {
      held.push({ ...heldEntry, reason })
      continue
    }

    // The cycle-cap gate: a revision fires whatever the latest review said. A refresh is a rebase, never a review cycle, so it is never capped. The effective cap folds in any operator-granted cycles.
    const effectiveCap = reviewCycleCap + cycleGrantCount(item.comments ?? undefined)
    if (stage === 'revise' && item.ticket.status.kind === 'queued' && item.ticket.status.reason === 'changes-requested' && (item.reviewCycleCount ?? 0) >= effectiveCap) {
      held.push({ ...heldEntry, reason: 'cycle-cap', escalation: { kind: 'cycle-cap', count: item.reviewCycleCount ?? 0, cap: effectiveCap } })
      continue
    }
    if (stage === 'review') {
      const gated = reviewGate(item, p)
      if (gated !== null) {
        if ('held' in gated) held.push(gated.held)
        else adoptions.push(gated.adoption)
        continue
      }
    }

    // An issue whose pull request is already open on its own branch is adopted, never dispatched a second time.
    if (agent === 'impl') {
      const adoption = openPullRequestAdoption(item)
      if (adoption !== null) {
        adoptions.push(adoption)
        continue
      }
    }

    const cycle = stage === 'refresh' ? null : cycleOf(item, agent === 'revise' ? effectiveCap : reviewCycleCap)

    if (agent !== 'impl' || item.claimedFiles === null) {
      ungated.push({ ...entry, agent, unchecked: agent === 'impl' && item.claimedFiles === null, cycle })
      continue
    }

    structuredCandidates.push({ item: item.number, paths: item.claimedFiles })
    structuredMeta.set(item.number, { kind: item.kind, stage, trigger: entry.trigger })
  }

  const forcedNumbers = new Set(structuredCandidates.filter((c) => forceDispatch?.has(repoId, c.item) ?? false).map((c) => c.item))
  const gateInput = structuredCandidates.filter((c) => !forcedNumbers.has(c.item))

  const metaOf = (number: number, source: string): NonNullable<ReturnType<typeof structuredMeta.get>> => {
    const meta = structuredMeta.get(number)
    if (meta === undefined) throw new Error(`${source} carried #${String(number)}, which was never a structured candidate`)
    return meta
  }

  // Always `null` cycle: every structured candidate is an impl candidate over an issue.
  const forcedActionable: TickActionable[] = [...forcedNumbers].map((number) => ({ number, ...metaOf(number, 'forceDispatch'), agent: 'impl', unchecked: false, cycle: null }))

  const gated = gateCandidates(gateInput, occupiedSet, concurrency.sharedFiles, concurrency.overlapThreshold)
  const gatedActionable: TickActionable[] = gated.dispatch.map((number) => ({ number, ...metaOf(number, 'gateCandidates dispatched'), agent: 'impl', unchecked: false, cycle: null }))

  for (const h of gated.held) {
    held.push({
      number: h.item,
      ...metaOf(h.item, 'gateCandidates held'),
      reason: 'contended',
      contention: { blocker: h.blocker, blockerStage: h.blockerLabel, depth: h.depth, paths: h.contendedPaths },
      escalation: null,
    })
  }

  forceDispatch?.prune(repoId, new Set(structuredCandidates.map((c) => c.item)))

  return { actionable: [...ungated, ...forcedActionable, ...gatedActionable], held, adoptions }
}

export function planTick(params: PlanTickParams): TickReport {
  const { repository, nextDecisionAt, now, reviewCycleCap, unknownStreaks, startedTasks, refreshMemo, checkDispositions, holdSessionRequired } = params
  const stageLiveness = params.stageLiveness ?? null
  const endedStages = params.endedStages ?? []

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

  const { actionable, held, adoptions: triggerAdoptions } = actionableAndHeld({
    items: repository.items,
    viewer: repository.viewer,
    concurrency: repository.concurrency,
    reviewCycleCap,
    repoId: repository.repoId,
    unknownStreaks,
    holdSessionRequired,
    forceDispatch: params.forceDispatch,
    checkDispositions,
    now: now(),
    integrationChecks: repository.integrationChecks,
  })
  const claims = claimsOf({ items: repository.items, repoId: repository.repoId, runsOf: params.runsOf ?? (() => []), startedTasks, readAt, holdSessionRequired, stageLiveness })
  const claimAdoptions = adoptionsOf({ items: repository.items, claims, viewer: repository.viewer })
  const adopted = new Set(claimAdoptions.map((adoption) => adoption.number))

  const liveNumbers = new Set(startedTasks.map((description) => Number(description.split('#')[1])).filter((n) => !Number.isNaN(n)))
  const { observations: repairObservations, reports: labelRepairs } = repairsOf({
    items: repository.items,
    endedStages,
    liveNumbers,
    viewer: repository.viewer,
    readAt,
  })

  const observations: readonly TickObservation[] = [
    ...claimAdoptions,
    ...triggerAdoptions,
    ...repairObservations,
    ...observationsOf({
      repoId: repository.repoId,
      items: repository.items,
      claims,
      held,
      viewer: repository.viewer,
      refreshMemo,
      checkDispositions,
      adopted,
      rerunMemo: params.rerunMemo,
    }),
  ]

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
    labelRepairs,
  }
}
