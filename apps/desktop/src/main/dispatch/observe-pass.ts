// #292: the observation pass itself, split out of `dispatcher.ts` to keep
// that file under the 500-line limit (docs/ENGINEERING.md §7) — `dispatcher.ts`'s
// own `considerRepo` is the only caller. In report order, skip an item this
// process already wrote at or after the repository's current read (the read
// has not caught up to that write yet), otherwise build and run the write. A
// throw from the write itself becomes `outcome: 'failed'`, never a pass that
// stops partway through the rest of the list.
import type { ReadyEntry } from '../actions'
import type { ApplyObservationParams, ApplyObservationResult } from '../actions'
import type { ObservationRecord } from '../../shared/dispatch/types'
import type { RefreshMemo } from '../tick'
import type { RepositoryState } from '../../shared/state/types'
import type { TickObservation } from '../../shared/tick/types'
import type { WriteOutcome } from '../../shared/writes/types'
import type { WriteObservation } from './observation'

const OBSERVED_LIMIT = 20

export interface ObservationPassDeps {
  readonly writeObservation: (params: ApplyObservationParams) => Promise<ApplyObservationResult>
  readonly refreshMemo: RefreshMemo
  readonly dirs: { readonly audit: string; readonly scratch: string }
  readonly now: () => Date
  readonly onChange: () => void
}

/** The mutable slice of `RepoDispatcherState` this pass reads and writes —
 *  `dispatcher.ts` passes its own state object directly, since both already
 *  agree on this shape. */
export interface ObservationPassState {
  observed: ObservationRecord[]
  observedWriteAt: Map<number, string>
}

/** `main/actions/observe.ts`'s own `WriteOutcome` → `ObservationRecord.outcome`
 *  mapping (plan's own **ObservationRecord** table). */
function observationOutcomeOf(outcome: WriteOutcome): ObservationRecord['outcome'] {
  switch (outcome.kind) {
    case 'applied':
      return 'written'
    case 'no-op':
      return 'already'
    case 'precondition-failed':
    case 'item-unavailable':
      return 'moved'
    case 'unclaimed-scope':
    case 'claim-unreadable':
    case 'unresolvable-label':
      return 'refused'
    case 'verify-failed':
    case 'write-failed':
      return 'failed'
  }
}

function observationScopeOf(outcome: WriteOutcome): ObservationRecord['scope'] {
  return outcome.kind === 'unclaimed-scope' || outcome.kind === 'claim-unreadable' ? outcome.scope : null
}

function pushObserved(state: ObservationPassState, record: ObservationRecord): void {
  const next = [...state.observed, record]
  state.observed = next.length > OBSERVED_LIMIT ? next.slice(next.length - OBSERVED_LIMIT) : next
}

export async function runObservationPass(
  entry: ReadyEntry,
  observable: readonly TickObservation[],
  repository: Extract<RepositoryState, { readonly ok: true }>,
  state: ObservationPassState,
  deps: ObservationPassDeps,
): Promise<void> {
  const fetchedAt = 'at' in repository.freshness.github ? repository.freshness.github.at : null
  const itemsByNumber = new Map(repository.items.map((item) => [item.number, item] as const))

  for (const observation of observable) {
    const lastWriteAt = state.observedWriteAt.get(observation.number)
    if (fetchedAt !== null && lastWriteAt !== undefined && lastWriteAt >= fetchedAt) continue

    const item = itemsByNumber.get(observation.number)
    if (item === undefined) continue

    const at = deps.now().toISOString()
    try {
      const result = await deps.writeObservation({ entry, item, observation: observation as WriteObservation, auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch })
      state.observedWriteAt.set(observation.number, at)
      if (result.labels.kind === 'applied') {
        if (observation.kind === 'refresh') deps.refreshMemo.set(entry.id, observation.number, { sha: observation.headRefOid, count: observation.count })
        else if (observation.kind === 'refresh-stuck') deps.refreshMemo.clear(entry.id, observation.number)
      }
      pushObserved(state, {
        kind: observation.kind,
        number: observation.number,
        itemKind: observation.itemKind,
        at,
        outcome: observationOutcomeOf(result.labels),
        scope: observationScopeOf(result.labels),
        comment: result.comment === null ? 'none' : result.comment.kind === 'applied' ? 'posted' : 'failed',
      })
    } catch {
      state.observedWriteAt.set(observation.number, at)
      pushObserved(state, { kind: observation.kind, number: observation.number, itemKind: observation.itemKind, at, outcome: 'failed', scope: null, comment: 'none' })
    }
  }
  deps.onChange()
}
