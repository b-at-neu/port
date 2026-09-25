// planTick — one RepositoryState to one TickReport (#105). Pure: no `gh`, no
// timer, no write. Blind first (fails closed on actions, never on
// reporting), then the trigger-stage set (actionable/held) and the
// in-flight set (claims), each in the order plan's own **Implementation**
// states. #106 adds the file-contention gate as a fourth, narrower filter
// applied only to `impl` candidates that already survived ownership and
// session-required.
import type { PipelineItemKind } from '../../shared/github/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { TickActionable, TickBlind, TickClaim, TickHeld, TickReport } from '../../shared/tick/types'
import type { ClaimedItem, OccupiedEntry } from './contention'
import { gateCandidates } from './contention'
import type { DispatchLedger } from './ledger'
import { classifyUnmatched, RETRY_TRIGGER } from './liveness'
import { partitionOwnership } from './ownership'
import { AGENT_FOR_TRIGGER } from './routing'

export interface PlanTickParams {
  readonly repository: RepositoryState
  readonly ledger: DispatchLedger
  /** This repository's own GitHub source's next-due instant
   *  (`nextDueAt(health.github, now)`) — carried onto the report's own
   *  `nextTickAt`, never derived a second time here; `main/state/watcher.ts`
   *  already owns that computation for its own scheduling. */
  readonly nextDecisionAt: Date
  readonly now: () => Date
}

function emptyReport(repoId: RepoId, displayName: string, blind: TickBlind): TickReport {
  return { repoId, displayName, blind, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null }
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
function heldReasonOf(item: ReconciledItem, unowned: ReadonlySet<number>, others: ReadonlySet<number>): Exclude<TickHeld['reason'], 'contended'> | null {
  if (unowned.has(item.number)) return 'unowned'
  if (others.has(item.number)) return 'other-operator'
  if (item.sessionRequired) return 'session-required'
  return null
}

/** The file-contention gate's own occupied set (PIPELINE.md → "File
 *  contention" → "The occupied set"): every item whose winning stage key is
 *  `inProgress`, plus every open item at `prOpened` — an open issue at that
 *  label is exactly "a pull request exists for it and has not merged", so
 *  this is the whole unmerged-branch set with no second query. `claimedFiles
 *  ?? []` per PIPELINE.md's own phrasing — an unstructured in-flight item
 *  occupies nothing, it never blocks a candidate the way a structured one
 *  does. */
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
): { readonly actionable: readonly TickActionable[]; readonly held: readonly TickHeld[] } {
  const held: TickHeld[] = []

  const triggerItems = items.filter(
    (item) =>
      item.stage === 'trigger' &&
      // Defensive: `STAGE_PRECEDENCE` already ranks `in-flight` above
      // `trigger`, so a `trigger`-staged item can never carry an in-flight
      // label too — checked anyway, since this module never assumes another
      // module's ranking stays exactly as ordered today.
      !item.stages.some((label) => label.role === 'in-flight'),
  )
  const { unowned, others } = partitionOwnership(triggerItems, viewer)
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
    if (reason !== null) {
      held.push({ number: item.number, kind: item.kind, trigger, reason, contention: null })
      continue
    }
    const agent = AGENT_FOR_TRIGGER[trigger]
    if (agent === undefined) continue

    if (agent !== 'impl' || item.claimedFiles === null) {
      ungated.push({ number: item.number, kind: item.kind, trigger, agent, unchecked: agent === 'impl' && item.claimedFiles === null })
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
    return { number, kind: meta.kind, trigger: meta.trigger, agent: 'impl', unchecked: false }
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
    })
  }

  return { actionable: [...ungated, ...gatedActionable], held }
}

function claimsOf(items: readonly ReconciledItem[], repoId: RepoId, ledger: DispatchLedger): readonly TickClaim[] {
  const claims: TickClaim[] = []
  for (const item of items) {
    if (item.stage !== 'in-flight') continue
    const inFlight = stageKeyOf(item)
    if (inFlight === null) continue

    if (item.sessionRequired) {
      claims.push({ number: item.number, kind: item.kind, inFlight, class: 'session-required', retryKey: null })
      continue
    }
    if (item.status === 'in-flight') {
      claims.push({ number: item.number, kind: item.kind, inFlight, class: 'matched', retryKey: null })
      continue
    }

    const result = classifyUnmatched(ledger.rowFor(repoId, item.number))
    ledger.advance(repoId, item.number, result)
    const cls = result.class === 'reset' ? 'stalled-confirmed' : result.class
    const retryKey = cls === 'stalled-confirmed' ? (RETRY_TRIGGER[inFlight] ?? null) : null
    claims.push({ number: item.number, kind: item.kind, inFlight, class: cls, retryKey })
  }
  return claims
}

export function planTick(params: PlanTickParams): TickReport {
  const { repository, ledger, nextDecisionAt, now } = params

  if (!repository.ok) {
    const blind: TickBlind = repository.reason === 'not-ready' ? { reason: 'not-ready' } : { reason: 'github-unavailable', message: repository.message }
    return emptyReport(repository.repoId, repository.displayName, blind)
  }

  if (repository.viewer === null) {
    return emptyReport(repository.repoId, repository.displayName, { reason: 'viewer-unknown' })
  }

  const githubEntry = repository.freshness.github
  if ('at' in githubEntry) {
    const readAt = Date.parse(githubEntry.at)
    const ageMs = Number.isNaN(readAt) ? null : now().getTime() - readAt
    const threshold = SOURCE_BASE_INTERVAL_MS.github + STALE_GRACE_MS
    if (ageMs !== null && ageMs > threshold) {
      return emptyReport(repository.repoId, repository.displayName, { reason: 'stale-read', ageMs })
    }
  }

  const { actionable, held } = actionableAndHeld(repository.items, repository.viewer, repository.concurrency)
  const claims = claimsOf(repository.items, repository.repoId, ledger)

  return {
    repoId: repository.repoId,
    displayName: repository.displayName,
    blind: null,
    actionable,
    held,
    claims,
    disabledStages: repository.disabled,
    nextTickAt: nextDecisionAt.toISOString(),
  }
}
