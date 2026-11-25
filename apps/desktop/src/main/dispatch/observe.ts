import type { RefreshMemo, RerunMemo } from '@/types/tick'
import type { WriteObservation } from '@/types/dispatch'

// The observation pass: one write per observation, its outcome mapped onto the record the Board shows. A throw
// from the write becomes `outcome: 'failed'`, never a pass that stops partway through.
import type { ReadyEntry } from '@/types/actions'
import type { ApplyObservationParams, ApplyObservationResult, RerunChecksParams } from '@/types/actions'
import type { ObservationRecord, StageLabelWrites } from '@/types/dispatch'

import type { RepositoryState } from '@/types/state'
import type { TickObservation } from '@/types/tick'
import type { WriteOutcome } from '@/types/writes'


const OBSERVED_LIMIT = 20

interface ObservationPassDeps {
  readonly writeObservation: (params: ApplyObservationParams) => Promise<ApplyObservationResult>
  /** Where an `adopt` observation is applied: the same hand-back table and verification a session's own hand-back goes through. */
  readonly transition: StageLabelWrites['transition']
  readonly rerunChecks: (params: RerunChecksParams) => Promise<'applied' | 'failed'>
  readonly rerunMemo: RerunMemo
  readonly refreshMemo: RefreshMemo
  readonly dirs: { readonly audit: string; readonly scratch: string }
  readonly now: () => Date
  readonly onChange: () => void
}

/** The mutable slice of `RepoDispatcherState` this pass reads and writes. */
interface ObservationPassState {
  observed: ObservationRecord[]
  observedWriteAt: Map<number, string>
}

/** `WriteOutcome` → `ObservationRecord.outcome` mapping. */
function observationOutcomeOf(outcome: WriteOutcome): ObservationRecord['outcome'] {
  switch (outcome.kind) {
    case 'applied':
    case 'mirror-failed':
      return 'written'
    case 'no-op':
      return 'already'
    case 'precondition-failed':
    case 'item-unavailable':
      return 'moved'
    case 'ownership-unreadable':
    case 'unresolvable-label':
      return 'refused'
    case 'verify-failed':
    case 'write-failed':
    case 'state-unsaved':
      return 'failed'
  }
}

function pushObserved(state: ObservationPassState, record: ObservationRecord): void {
  const next = [...state.observed, record]
  state.observed = next.length > OBSERVED_LIMIT ? next.slice(next.length - OBSERVED_LIMIT) : next
}

/** An adoption goes through the hand-back table and its verification, never a label plan of its own; a re-run is remembered per head whether or not it started, so one head is never re-run twice. */
async function applyOwnWrite(entry: ReadyEntry, observation: Extract<TickObservation, { readonly kind: 'adopt' | 'rerun-checks' }>, deps: ObservationPassDeps): Promise<ObservationRecord['outcome']> {
  if (observation.kind === 'rerun-checks') {
    const result = await deps.rerunChecks({ entry, number: observation.number, runs: observation.runs, auditDir: deps.dirs.audit })
    deps.rerunMemo.set(entry.id, observation.number, observation.headRefOid)
    return result === 'applied' ? 'written' : 'failed'
  }
  const record = { number: observation.number, kind: observation.itemKind, agent: observation.agent, trigger: observation.trigger }
  const result = await deps.transition({ entry, record, event: { kind: 'adopt', handback: observation.handback }, auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch })
  if (result.kind === 'applied') return 'written'
  if (result.reason === 'moved') return 'moved'
  return result.retryable ? 'failed' : 'refused'
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
      if (observation.kind === 'adopt' || observation.kind === 'rerun-checks') {
        const outcome = await applyOwnWrite(entry, observation, deps)
        state.observedWriteAt.set(observation.number, at)
        pushObserved(state, { kind: observation.kind, number: observation.number, itemKind: observation.itemKind, at, outcome, comment: 'none' })
        continue
      }
      const result = await deps.writeObservation({ entry, item, observation: observation as WriteObservation, snapshotAt: fetchedAt, auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch })
      state.observedWriteAt.set(observation.number, at)
      if (observationOutcomeOf(result.labels) === 'written') {
        if (observation.kind === 'refresh') deps.refreshMemo.set(entry.id, observation.number, { sha: observation.headRefOid, count: observation.count })
        else if (observation.kind === 'refresh-stuck') deps.refreshMemo.clear(entry.id, observation.number)
      }
      pushObserved(state, {
        kind: observation.kind,
        number: observation.number,
        itemKind: observation.itemKind,
        at,
        outcome: observationOutcomeOf(result.labels),
        comment: result.comment === null ? 'none' : result.comment.kind === 'applied' ? 'posted' : 'failed',
      })
    } catch {
      state.observedWriteAt.set(observation.number, at)
      pushObserved(state, { kind: observation.kind, number: observation.number, itemKind: observation.itemKind, at, outcome: 'failed', comment: 'none' })
    }
  }
  deps.onChange()
}
