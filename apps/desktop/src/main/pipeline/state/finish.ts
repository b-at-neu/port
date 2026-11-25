// The mirror writes that follow no transition: the terminal state of a merged pull request, and the per-poll retry of a failed mirror.
import type { StateWriteContext } from '@/main/pipeline/context'
import { mirrorItem } from '@/main/pipeline/state/writer'
import type { ReadyEntry } from '@/types/actions'
import type { TicketRef } from '@/types/pipeline-state'
import type { WriteOutcome } from '@/types/writes'
import type { Ticket } from '@/utils/pipeline/ticket'

const RETRY_LIMIT = 10
const RETRY_BACKOFF_MS = 5 * 60 * 1000

interface FinishedItems {
  readonly closed: readonly number[]
  readonly merged: readonly number[]
}

/** The half that names a ticket in an audit entry: its pull request when it has one. */
function refOf(ticket: Ticket): TicketRef {
  return ticket.pr === null ? { kind: 'issue', number: ticket.ticket } : { kind: 'pull-request', number: ticket.pr.number }
}

const retryKey = (entry: ReadyEntry, ticket: Ticket): string => `${entry.id}:${String(ticket.ticket)}`

const mirror = (ctx: StateWriteContext, entry: ReadyEntry, ref: TicketRef, action: string, auditDir: string): Promise<WriteOutcome> => mirrorItem(ctx, { entry, ref, action, auditDir })

/** Marks each merged pull request the store holds done and shows it on both halves, then prunes `closed`; a closed but unmerged item is pruned untouched. */
export async function finishPipelineState(ctx: StateWriteContext, entry: ReadyEntry, finished: FinishedItems, auditDir: string): Promise<void> {
  const store = ctx.stores.pipelineState
  for (const number of finished.merged) {
    const ref: TicketRef = { kind: 'pull-request', number }
    if (store.ticket(entry.id, ref) === null) continue
    const merged = await store.apply(entry.id, ref, { kind: 'merged' }, null)
    if (merged.ok) await mirror(ctx, entry, ref, 'mirror-merged', auditDir)
  }
  await store.prune(entry.id, finished.closed)
}

/** Retries each failed ticket at most once per backoff window, so a failure that persists neither floods the audit log nor re-reads the item on every poll. */
export async function retryMirrors(ctx: StateWriteContext, entry: ReadyEntry, auditDir: string, retried: Map<string, number>): Promise<void> {
  const failed = (ctx.stores.pipelineState.tickets(entry.id) ?? []).filter((ticket) => ticket.mirror.failure !== null)
  const failedKeys = new Set(failed.map((ticket) => retryKey(entry, ticket)))
  for (const key of retried.keys()) if (key.startsWith(`${entry.id}:`) && !failedKeys.has(key)) retried.delete(key)
  const now = ctx.clock.now().getTime()
  const due = failed.filter((ticket) => {
    const last = retried.get(retryKey(entry, ticket))
    return last === undefined || now - last >= RETRY_BACKOFF_MS
  })
  for (const ticket of due.slice(0, RETRY_LIMIT)) {
    retried.set(retryKey(entry, ticket), now)
    await mirror(ctx, entry, refOf(ticket), 'mirror-retry', auditDir)
  }
}
