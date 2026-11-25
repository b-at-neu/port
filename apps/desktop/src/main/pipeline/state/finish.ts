// The mirror writes that follow no transition: the terminal state of a merged pull request, and the per-poll retry of a failed mirror.
import type { ReadyEntry } from '@/types/actions'
import type { MirrorItemParams, PipelineStateStore, TicketRef } from '@/types/pipeline-state'
import type { WriteOutcome } from '@/types/writes'
import type { Ticket } from '@/utils/pipeline/ticket'

const RETRY_LIMIT = 10
const RETRY_BACKOFF_MS = 5 * 60 * 1000

interface FinishDeps {
  readonly store: PipelineStateStore
  readonly mirrorItem: (params: MirrorItemParams) => Promise<WriteOutcome>
  readonly auditDir: string
  readonly now?: () => number
}

interface FinishedItems {
  readonly closed: readonly number[]
  readonly merged: readonly number[]
}

export interface PipelineFinish {
  readonly finishPipelineState: (entry: ReadyEntry, finished: FinishedItems) => Promise<void>
  readonly retryMirrors: (entry: ReadyEntry) => Promise<void>
}

/** The half that names a ticket in an audit entry: its pull request when it has one. */
function refOf(ticket: Ticket): TicketRef {
  return ticket.pr === null ? { kind: 'issue', number: ticket.ticket } : { kind: 'pull-request', number: ticket.pr.number }
}

export function createPipelineFinish(deps: FinishDeps): PipelineFinish {
  const now = deps.now ?? Date.now
  const lastRetry = new Map<string, number>()
  const retryKey = (entry: ReadyEntry, ticket: Ticket): string => `${entry.id}:${String(ticket.ticket)}`

  const mirror = (entry: ReadyEntry, ref: TicketRef, action: string): Promise<WriteOutcome> => deps.mirrorItem({ entry, ref, action, auditDir: deps.auditDir })

  return {
    /** Marks each merged pull request the store holds done and shows it on both halves, then prunes `closed`; a closed but unmerged item is pruned untouched. */
    async finishPipelineState(entry, finished) {
      for (const number of finished.merged) {
        const ref: TicketRef = { kind: 'pull-request', number }
        if (deps.store.ticket(entry.id, ref) === null) continue
        const merged = await deps.store.apply(entry.id, ref, { kind: 'merged' }, null)
        if (merged.ok) await mirror(entry, ref, 'mirror-merged')
      }
      await deps.store.prune(entry.id, finished.closed)
    },
    /** Retries each failed ticket at most once per backoff window, so a failure that persists neither floods the audit log nor re-reads the item on every poll. */
    async retryMirrors(entry) {
      const failed = (deps.store.tickets(entry.id) ?? []).filter((ticket) => ticket.mirror.failure !== null)
      const failedKeys = new Set(failed.map((ticket) => retryKey(entry, ticket)))
      for (const key of lastRetry.keys()) if (key.startsWith(`${entry.id}:`) && !failedKeys.has(key)) lastRetry.delete(key)
      const due = failed.filter((ticket) => {
        const last = lastRetry.get(retryKey(entry, ticket))
        return last === undefined || now() - last >= RETRY_BACKOFF_MS
      })
      for (const ticket of due.slice(0, RETRY_LIMIT)) {
        lastRetry.set(retryKey(entry, ticket), now())
        await mirror(entry, refOf(ticket), 'mirror-retry')
      }
    },
  }
}
