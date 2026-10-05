// planTick — one RepositoryState to one TickReport (#105). Pure: no `gh`, no
// timer, no write. Blind first (fails closed on actions, never on
// reporting), then the trigger-stage set (actionable/held) and the
// in-flight set (claims), each in the order plan's own **Implementation**
// states. #106 adds the file-contention gate as a fourth, narrower filter
// applied only to `impl` candidates that already survived ownership and
// session-required. #108 adds the cycle-cap/zero-diff gates, checked per
// trigger item after the ownership/session-required ladder and before the
// file-contention gate — this app computes the decision and the report, it
// never writes the escalation itself (the real write lands beside the
// eventual dispatch call, per the plan's own **Risks / notes**).
import type { PipelineItemKind } from '../../shared/github/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { TickActionable, TickBlind, TickClaim, TickHeld, TickHeldReason, TickObservation, TickReport } from '../../shared/tick/types'
import type { ClaimedItem, OccupiedEntry } from '../../../../../scripts/port-tick/contention'
import { gateCandidates } from '../../../../../scripts/port-tick/contention'
import type { Disposition } from '../../../../../scripts/port-tick/checks'
import { cycleCapExceeded, mergeabilityRoute, refreshWins, zeroDiffGate } from '../../../../../scripts/port-tick/gates'
import type { DispatchLedger, RefreshMemo, UnknownStreaks } from './ledger'
import { RETRY_TRIGGER } from '../../../../../scripts/port-tick/liveness'
import { observationsOf } from './observe'
import { partitionOwnership } from '../../../../../scripts/port-tick/classify'
import { AGENT_FOR_IN_FLIGHT, AGENT_FOR_TRIGGER } from './routing'

export interface PlanTickParams {
  readonly repository: RepositoryState
  readonly ledger: DispatchLedger
  /** This app's own process-scoped mergeability-UNKNOWN memo (#265) — the
   *  equivalent of the cockpit's `tickState.unknownStreak`, read and written
   *  only by the `readyForReview` mergeability check below. */
  readonly unknownStreaks: UnknownStreaks
  /** This repository's own GitHub source's next-due instant
   *  (`nextDueAt(health.github, now)`) — carried onto the report's own
   *  `nextTickAt`, never derived a second time here; `main/state/watcher.ts`
   *  already owns that computation for its own scheduling. */
  readonly nextDecisionAt: Date
  readonly now: () => Date
  /** `entry.config.reviewCycleCap` (#108) — read from config per repository,
   *  never hardcoded; `main/state/watcher.ts` passes it through the same way
   *  it already does `repository.concurrency`. */
  readonly reviewCycleCap: number
  /** #292, #326: this repository's own live stage sessions, as descriptions
   *  (`dispatcher.ts`'s own `liveStages`) — `[]` when none are live. An
   *  in-flight claim matches when either the session scan (`item.status ===
   *  'in-flight'`) or this app's own dispatch loop record says so, so a
   *  reset never fires against a session this app itself just launched. */
  readonly startedTasks: readonly string[]
  /** #292: the app's own process-scoped refresh memo
   *  (`main/tick/ledger.ts`'s `createRefreshMemo`) — read and written only
   *  by `observationsOf`'s refresh family. */
  readonly refreshMemo: RefreshMemo
  /** #292, generalized in #300: `entry.config.checkDispositions` — read from
   *  config per repository, never hardcoded; feeds the approval-withdrawal
   *  observation's own `rollupVerdict` call. */
  readonly checkDispositions: Readonly<Record<string, Disposition>>
}

function emptyReport(repoId: RepoId, displayName: string, blind: TickBlind): TickReport {
  return { repoId, displayName, blind, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [] }
}

/** The winning `StageLabel`'s own key — `null` only when `item.stage` is
 *  `null`, which never happens for the two callers below (both already
 *  filtered to a specific `stage`). A local copy rather than an import from
 *  `shared/actions/plan.ts`: that module answers an operator-action
 *  question, this one a dispatch question, and `main/tick/` stays its own
 *  self-contained decision, the same way `scripts/port-tick/`'s families do. */
function stageKeyOf(item: Pick<ReconciledItem, 'stage' | 'stages'>): LabelKey | null {
  if (item.stage === null) return null
  return item.stages.find((label) => label.role === item.stage)?.key ?? null
}

/** Held reasons, first hit wins: unowned before other-operator before
 *  session-required — the ladder `ReconciledItem.waitingOn` already uses,
 *  with an ownership check inserted ahead of the session-required one,
 *  since a tick (unlike `waitingOn`) knows the viewer. `contended` is never
 *  returned here — it is the file-contention gate's own reason, applied
 *  afterward and only to the `impl` candidates that survive this ladder.
 *  The unowned/other-operator split itself is never re-derived by hand here
 *  — it comes from `partitionOwnership`, the same ported-and-pinned
 *  primitive `ownership.test.ts` asserts against the shared case table, so a
 *  future change to `classify.mjs`'s rule can't silently diverge from this
 *  caller. */
function heldReasonOf(item: ReconciledItem, unowned: ReadonlySet<number>, others: ReadonlySet<number>): Exclude<TickHeld['reason'], 'contended' | 'cycle-cap' | 'zero-diff'> | null {
  if (unowned.has(item.number)) return 'unowned'
  if (others.has(item.number)) return 'other-operator'
  if (item.sessionRequired) return 'session-required'
  return null
}

/** `TickActionable.cycle` — populated only when this item carries a
 *  precomputed review count (a `revise`/`review` candidate; `null` for
 *  every other agent, since `reviewCycleCount` is pull-request only). */
function cycleOf(item: ReconciledItem, cap: number): { readonly count: number; readonly cap: number } | null {
  return item.reviewCycleCount !== null ? { count: item.reviewCycleCount, cap } : null
}

/** The file-contention gate's own occupied set (PIPELINE.md → "File
 *  contention" → "The occupied set"): every item whose winning stage key is
 *  `inProgress`, plus every open item at `prOpened` — an open issue at that
 *  label is exactly "a pull request exists for it and has not merged", so
 *  this is the whole unmerged-branch set with no second query. `claimedFiles
 *  ?? []` per PIPELINE.md's own phrasing — an unstructured in-flight item
 *  occupies nothing, it never blocks a candidate the way a structured one
 *  does. */
/** Every item number carrying `key` among its (plural) `stages` — an
 *  ownership-independent fact, deliberately not filtered to the viewer or to
 *  `item.stage`'s own single winning role, since `refreshBranch` can sit
 *  alongside another trigger (the `<labels.approved>` carve-out's own
 *  shape) and the refresh-wins veto must see it regardless of which label
 *  `item.stage` resolved to (#265). */
function numbersCarrying(items: readonly ReconciledItem[], key: LabelKey): readonly number[] {
  return items.filter((item) => item.stages.some((label) => label.key === key)).map((item) => item.number)
}

/** The mergeability gate's own held reason, or `null` to proceed —
 *  `readyForReview` only (PIPELINE.md → "Check evidence" → "Mergeability
 *  precondition", #265). `CONFLICTING` and `MERGEABLE` both clear the
 *  streak memo outright ("cleared for any item that reads non-UNKNOWN");
 *  `UNKNOWN` consults `mergeabilityRoute` with the memo's own prior streak,
 *  holding once before dispatching on the second consecutive poll; `null`
 *  holds every poll, unconditionally — GitHub has not reported anything yet,
 *  so this fails closed on action rather than ever guessing. */
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

/** Splits the trigger-stage set into: `held` (ownership/session-required,
 *  the file-contention gate's own `contended` holds appended after), and
 *  `actionable` in the real dispatch order — every ungated agent (non-`impl`
 *  triggers, plus `impl` triggers whose plan carried no ` ```files ` fence
 *  at all, `unchecked: true`) in item order, then the structured `impl`
 *  survivors in `gateCandidates`' own fewest-conflicts-first order, so the
 *  eventual dispatcher consumes the list directly rather than re-sorting
 *  it. */
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
      // Defensive: `STAGE_PRECEDENCE` already ranks `in-flight` above
      // `trigger`, so a `trigger`-staged item can never carry an in-flight
      // label too — checked anyway, since this module never assumes another
      // module's ranking stays exactly as ordered today.
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

    // #292: a `refreshBranch` trigger co-present with another trigger label
    // never wins `stageKeyOf`'s own first-match resolution, so without this
    // the refresh itself would never get its own actionable entry — stranding
    // the pull request, since its other trigger's own refresh-wins veto
    // (below) holds it instead. Its other trigger keeps that hold unchanged;
    // this yields a second, independent entry for `refreshBranch` itself,
    // run through the same ownership/session-required ladder (`reason`,
    // already computed above).
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

    // The refresh-wins veto (#225, #265) — a pull request already claimed by
    // a refresh must never also be dispatched to review or revision in the
    // same tick. Scoped to `needsRevision` specifically, never the bare
    // `agent === 'revise'` test the cycle-cap gate below still uses: a
    // `refreshBranch` trigger's own dispatch is the refresh itself, so
    // vetoing it against its own label would deadlock every refresh.
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

    // The cycle-cap gate — unconditional, per `cycleCapExceeded`'s own
    // contract: fires whatever the latest review said.
    if (agent === 'revise' && cycleCapExceeded(item.reviews ?? undefined, reviewCycleCap)) {
      held.push({
        number: item.number,
        kind: item.kind,
        trigger,
        reason: 'cycle-cap',
        contention: null,
        escalation: { kind: 'cycle-cap', count: item.reviewCycleCount ?? 0, cap: reviewCycleCap },
      })
      continue
    }
    // The zero-diff gate — `dispatch`/`dispatch-once` both fall through to
    // ordinary dispatch below; the one-time re-review permission is
    // inherent in the label state itself, nothing further to track here.
    if (
      agent === 'review' &&
      zeroDiffGate({ reviews: item.reviews ?? undefined, comments: item.comments ?? undefined, headRefOid: item.headRefOid ?? '' }).action === 'escalate'
    ) {
      held.push({ number: item.number, kind: item.kind, trigger, reason: 'zero-diff', contention: null, escalation: { kind: 'zero-diff' } })
      continue
    }

    const cycle = cycleOf(item, reviewCycleCap)

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
    // Defensive: every number in `gated.dispatch` came from `structuredCandidates`,
    // built from this same map's keys, just above.
    if (meta === undefined) throw new Error(`gateCandidates dispatched #${String(number)}, which was never a structured candidate`)
    // Always `null`: every structured candidate is an `impl` trigger over an
    // issue, and `reviewCycleCount` is pull-request only.
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
    // #292: either source is enough to hold a reset back — a session scan
    // hit (the pre-existing rule) or this app's own dispatcher session
    // reporting the matching task as `started`, so a reset never fires
    // against an agent this process itself just dispatched before the
    // session scan has caught up to it.
    const agentForInFlight = AGENT_FOR_IN_FLIGHT[inFlight]
    const matchedByTask = agentForInFlight !== undefined && startedTasks.includes(`${agentForInFlight} #${String(item.number)}`)
    if (item.status === 'in-flight' || matchedByTask) {
      claims.push({ number: item.number, kind: item.kind, inFlight, class: 'matched', retryKey: null })
      continue
    }

    const result = ledger.observeUnmatched(repoId, item.number, readAt)
    const cls = result.class === 'reset' ? 'stalled-confirmed' : result.class
    // RETRY_TRIGGER's engine type is a bare Record<string, string> — every
    // value is a real LabelKey by construction (the vocabulary pin in
    // scripts/checks/desktop-tick.ts), so the app's own in-flight caller
    // narrows it here rather than widening the engine's own export.
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
  }
}
