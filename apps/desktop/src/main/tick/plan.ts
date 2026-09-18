// planTick — one RepositoryState to one TickReport (#105). Pure: no `gh`, no
// timer, no write. Blind first (fails closed on actions, never on
// reporting), then the trigger-stage set (actionable/held) and the
// in-flight set (claims), each in the order plan's own **Implementation**
// states.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { TickActionable, TickBlind, TickClaim, TickHeld, TickReport } from '../../shared/tick/types'
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
 *  since a tick (unlike `waitingOn`) knows the viewer. The unowned/
 *  other-operator split itself is never re-derived by hand here — it comes
 *  from `partitionOwnership`, the same ported-and-pinned primitive
 *  `ownership.test.ts` asserts against the shared case table, so a future
 *  change to `classify.mjs`'s rule can't silently diverge from this caller. */
function heldReasonOf(item: ReconciledItem, unowned: ReadonlySet<number>, others: ReadonlySet<number>): TickHeld['reason'] | null {
  if (unowned.has(item.number)) return 'unowned'
  if (others.has(item.number)) return 'other-operator'
  if (item.sessionRequired) return 'session-required'
  return null
}

function actionableAndHeld(items: readonly ReconciledItem[], viewer: string): { readonly actionable: readonly TickActionable[]; readonly held: readonly TickHeld[] } {
  const actionable: TickActionable[] = []
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

  for (const item of triggerItems) {
    const trigger = stageKeyOf(item)
    if (trigger === null) continue

    const reason = heldReasonOf(item, unownedNumbers, othersNumbers)
    if (reason !== null) {
      held.push({ number: item.number, kind: item.kind, trigger, reason })
      continue
    }
    const agent = AGENT_FOR_TRIGGER[trigger]
    if (agent === undefined) continue
    actionable.push({ number: item.number, kind: item.kind, trigger, agent })
  }
  return { actionable, held }
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

  const { actionable, held } = actionableAndHeld(repository.items, repository.viewer)
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
