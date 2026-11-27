// Per-repository pending stage label writes: serialized, retried a bounded number of times, and reported rather than guessed.
import { eventWrites } from '@/main/pipeline/transitions'
import { modeOfStage } from '@/types/stage-labels'
import { draftOf, handoffRefusalIntent, noRelated } from '@/main/pipeline/incidents/raise'
import type { ReadyEntry } from '@/types/actions'
import type { StageSnapshot } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { StageEvent, StageLabelResult, StagePlanFile, StageTransitionResult } from '@/types/stage-labels'
import type { StateWriteContext } from '@/main/pipeline/context'
import { applyStageTransition } from '@/main/pipeline/operator/stage'
import type { Platform } from '@/main/platform'
import { requestRead } from '@/main/dispatch/context'
import type { DispatchContext } from '@/main/dispatch/context'
import type { StageOutcome } from '@/types/stage-session'
import type { TickActionable } from '@/types/tick'
import type { RepoId } from '@/utils/repos'

/** Total attempts for one hand-back write, the first included. */
export const HANDOFF_ATTEMPTS = 3

/** A retryable refusal keeps retrying this long after its first attempt, so a write that fails while DNS comes back after a wake still lands. */
export const HANDOFF_RETRY_WINDOW_MS = 600_000

type HandoffRecord = Pick<TickActionable, 'number' | 'kind' | 'agent' | 'stage'> & { readonly sessionKey: SessionKey }

interface PendingWrite {
  readonly repoId: RepoId
  readonly record: HandoffRecord
  readonly event: StageEvent
  /** `null` for a write nobody reads a result for, such as the next turn after a block. */
  readonly resultKey: SessionKey | null
  attempts: number
  /** Epoch milliseconds of the first attempt, `null` before it. */
  firstAttemptAt: number | null
}

type HandoffContext = StateWriteContext & Pick<Platform, 'clock' | 'paths'> & { readonly live: Pick<DispatchContext['live'], 'watcher'> }

export interface StageHandoff {
  /** Called once per pass, so a retry has the repository's current entry. */
  remember(entry: ReadyEntry): void
  /** Fire-and-forget: plans and writes this outcome's label move, serialized per repository. `plan` is captured once and replayed on every retry, since the worktree is gone by then. */
  settle(repoId: RepoId, record: HandoffRecord, outcome: StageOutcome, plan: StagePlanFile | null): void
  /** The session's next turn began after a block. */
  resumedTurn(repoId: RepoId, record: HandoffRecord): void
  /** Retries every pending write for the repository; resolves once each has been attempted. */
  retryPending(repoId: RepoId): Promise<void>
  /** `null` means pending, or that this outcome writes nothing. */
  resultFor(sessionKey: SessionKey): StageLabelResult | null
  /** The tickets with a write still being attempted for the repository — their session is settling, not dead. */
  pendingNumbers(repoId: RepoId): ReadonlySet<number>
}

/** `snapshotOf` is the tick's view of one ticket, kept for the incident a blocked or escalated hand-back may raise. */
export function createStageHandoff(ctx: HandoffContext, snapshotOf: (repoId: RepoId, number: number) => StageSnapshot): StageHandoff {
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
    write.firstAttemptAt ??= ctx.clock.now().getTime()
    let result: StageTransitionResult
    try {
      result = await applyStageTransition(ctx, { entry, record: write.record, event: write.event, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp, snapshot: snapshotOf(entry.id, write.record.number) })
    } catch (error) {
      result = { kind: 'refused', reason: 'write-failed', retryable: true, detail: error instanceof Error ? error.message : String(error) }
    }
    const windowOpen = ctx.clock.now().getTime() - write.firstAttemptAt < HANDOFF_RETRY_WINDOW_MS
    if (result.kind === 'refused' && result.retryable && (write.attempts < HANDOFF_ATTEMPTS || windowOpen)) return
    pending.delete(id)
    if (result.kind === 'refused') {
      const { record } = write
      const intent = handoffRefusalIntent(record, result.reason, write.attempts, result.retryable)
      void ctx.stores.incidentLog.record(draftOf(intent, { repo: entry.config.repo, kind: record.kind, number: record.number }, { kind: result.reason }, noRelated())).catch(() => undefined)
    }
    if (write.resultKey !== null) results.set(write.resultKey, result.kind === 'applied' ? { kind: 'applied' } : { kind: 'refused', reason: result.reason, detail: result.detail })
    if (write.event.kind === 'outcome' && write.event.outcome === 'completed') requestRead(ctx, write.repoId)
    ctx.live.watcher.republish()
  }

  function enqueue(id: string, write: PendingWrite): void {
    pending.set(id, write)
    void serialize(write.repoId, () => attempt(id, write))
  }

  return {
    remember(entry) {
      entries.set(entry.id, entry)
    },
    settle(repoId, record, outcome, plan) {
      const event: StageEvent = { kind: 'outcome', outcome: outcome.kind, handback: outcome.handback, plan }
      if (!eventWrites(event, modeOfStage(record.agent, record.stage))) return
      results.delete(record.sessionKey)
      enqueue(record.sessionKey, { repoId, record, event, resultKey: record.sessionKey, attempts: 0, firstAttemptAt: null })
    },
    resumedTurn(repoId, record) {
      enqueue(`resumed:${record.sessionKey}`, { repoId, record, event: { kind: 'resumed-turn' }, resultKey: null, attempts: 0, firstAttemptAt: null })
    },
    async retryPending(repoId) {
      const due = [...pending.entries()].filter(([, write]) => write.repoId === repoId)
      await Promise.all(due.map(([id, write]) => serialize(repoId, () => attempt(id, write))))
    },
    resultFor: (sessionKey) => results.get(sessionKey) ?? null,
    pendingNumbers: (repoId) => new Set([...pending.values()].filter((write) => write.repoId === repoId && write.event.kind === 'outcome').map((write) => write.record.number)),
  }
}
