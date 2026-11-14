// Per-repository pending stage label writes: serialized, retried a bounded number of times, and reported rather than guessed.
import { eventWrites, stageModeFor } from '@/main/dispatch/transitions'
import type { ReadyEntry } from '@/types/actions'
import type { SessionKey } from '@/types/hosting'
import type { StageEvent, StageLabelResult, StageTransitionResult } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { TickActionable } from '@/types/tick'
import type { RepoId } from '@/utils/repos'

/** Total attempts for one hand-back write, the first included. */
export const HANDOFF_ATTEMPTS = 3

type HandoffRecord = Pick<TickActionable, 'number' | 'kind' | 'agent' | 'trigger'> & { readonly sessionKey: SessionKey }

interface PendingWrite {
  readonly repoId: RepoId
  readonly record: HandoffRecord
  readonly event: StageEvent
  /** `null` for a write nobody reads a result for, such as the next turn after a block. */
  readonly resultKey: SessionKey | null
  attempts: number
}

interface StageHandoffDeps {
  readonly write: (params: { readonly entry: ReadyEntry; readonly record: HandoffRecord; readonly event: StageEvent; readonly auditDir: string }) => Promise<StageTransitionResult>
  readonly auditDir: string
  readonly onChange: () => void
  /** Asks for one GitHub read of this repository alone, so the next stage sees the label just written. */
  readonly requestRead: (repoId: RepoId) => void
}

export interface StageHandoff {
  /** Called once per pass, so a retry has the repository's current entry. */
  remember(entry: ReadyEntry): void
  /** Fire-and-forget: plans and writes this outcome's label move, serialized per repository. */
  settle(repoId: RepoId, record: HandoffRecord, outcome: StageOutcome): void
  /** The session's next turn began after a block. */
  resumedTurn(repoId: RepoId, record: HandoffRecord): void
  /** Retries every pending write for the repository; resolves once each has been attempted. */
  retryPending(repoId: RepoId): Promise<void>
  /** `null` means pending, or that this outcome writes nothing. */
  resultFor(sessionKey: SessionKey): StageLabelResult | null
}

export function createStageHandoff(deps: StageHandoffDeps): StageHandoff {
  const entries = new Map<RepoId, ReadyEntry>()
  const pending = new Map<string, PendingWrite>()
  const results = new Map<SessionKey, StageLabelResult>()
  const chains = new Map<RepoId, Promise<void>>()

  function serialize(repoId: RepoId, fn: () => Promise<void>): Promise<void> {
    const next = (chains.get(repoId) ?? Promise.resolve()).then(fn, fn)
    chains.set(repoId, next)
    return next
  }

  async function attempt(id: string, write: PendingWrite): Promise<void> {
    const entry = entries.get(write.repoId)
    if (entry === undefined || pending.get(id) !== write) return
    write.attempts += 1
    let result: StageTransitionResult
    try {
      result = await deps.write({ entry, record: write.record, event: write.event, auditDir: deps.auditDir })
    } catch (error) {
      result = { kind: 'refused', reason: 'write-failed', retryable: true, detail: error instanceof Error ? error.message : String(error) }
    }
    if (result.kind === 'refused' && result.retryable && write.attempts < HANDOFF_ATTEMPTS) return
    pending.delete(id)
    if (write.resultKey !== null) results.set(write.resultKey, result.kind === 'applied' ? { kind: 'applied' } : { kind: 'refused', reason: result.reason, detail: result.detail })
    if (write.event.kind === 'outcome' && write.event.outcome === 'completed') deps.requestRead(write.repoId)
    deps.onChange()
  }

  function enqueue(id: string, write: PendingWrite): void {
    pending.set(id, write)
    void serialize(write.repoId, () => attempt(id, write))
  }

  return {
    remember(entry) {
      entries.set(entry.id, entry)
    },
    settle(repoId, record, outcome) {
      const event: StageEvent = { kind: 'outcome', outcome: outcome.kind, handback: outcome.handback }
      if (!eventWrites(event, stageModeFor(record.agent, record.trigger))) return
      results.delete(record.sessionKey)
      enqueue(record.sessionKey, { repoId, record, event, resultKey: record.sessionKey, attempts: 0 })
    },
    resumedTurn(repoId, record) {
      enqueue(`resumed:${record.sessionKey}`, { repoId, record, event: { kind: 'resumed-turn' }, resultKey: null, attempts: 0 })
    },
    async retryPending(repoId) {
      const due = [...pending.entries()].filter(([, write]) => write.repoId === repoId)
      await Promise.all(due.map(([id, write]) => serialize(repoId, () => attempt(id, write))))
    },
    resultFor: (sessionKey) => results.get(sessionKey) ?? null,
  }
}
