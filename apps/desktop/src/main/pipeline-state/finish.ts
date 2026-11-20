// The mirror writes that follow no transition: the terminal state of a merged pull request, and the per-poll retry of a failed mirror.
import type { ReadyEntry } from '@/types/actions'
import type { MirrorItemParams, PipelineStateStore, StoredItem } from '@/types/pipeline-state'
import type { WriteOutcome } from '@/types/writes'

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

export function createPipelineFinish(deps: FinishDeps): PipelineFinish {
  const now = deps.now ?? Date.now
  const lastRetry = new Map<string, number>()
  const retryKey = (entry: ReadyEntry, item: StoredItem): string => `${entry.id}:${item.kind}:${item.number}`

  const mirror = (entry: ReadyEntry, item: StoredItem, action: string, mode: 'state' | 'merged'): Promise<WriteOutcome> =>
    deps.mirrorItem({ entry, ref: { kind: item.kind, number: item.number }, action, auditDir: deps.auditDir, mode })

  return {
    /** Writes `approved` on each merged pull request the store holds and on its ticket, then prunes `closed`; a closed but unmerged item is pruned untouched. */
    async finishPipelineState(entry, finished) {
      const view = deps.store.view(entry.id)
      if (view.kind === 'store') {
        for (const number of finished.merged) {
          const pr = view.items.find((item) => item.kind === 'pull-request' && item.number === number)
          if (pr === undefined) continue
          await mirror(entry, pr, 'mirror-merged', 'merged')
          const ticket = pr.issue === null ? undefined : view.items.find((item) => item.kind === 'issue' && item.number === pr.issue)
          if (ticket !== undefined) await mirror(entry, ticket, 'mirror-merged', 'merged')
        }
      }
      await deps.store.prune(entry.id, finished.closed)
    },
    /** Retries each failed item at most once per backoff window, so a failure that persists neither floods the audit log nor re-reads the item on every poll. */
    async retryMirrors(entry) {
      const view = deps.store.view(entry.id)
      if (view.kind !== 'store') return
      const failed = view.items.filter((candidate) => candidate.mirrorFailure !== null)
      const failedKeys = new Set(failed.map((item) => retryKey(entry, item)))
      for (const key of lastRetry.keys()) if (key.startsWith(`${entry.id}:`) && !failedKeys.has(key)) lastRetry.delete(key)
      const due = failed.filter((item) => {
        const last = lastRetry.get(retryKey(entry, item))
        return last === undefined || now() - last >= RETRY_BACKOFF_MS
      })
      for (const item of due.slice(0, RETRY_LIMIT)) {
        lastRetry.set(retryKey(entry, item), now())
        await mirror(entry, item, 'mirror-retry', 'state')
      }
    },
  }
}
