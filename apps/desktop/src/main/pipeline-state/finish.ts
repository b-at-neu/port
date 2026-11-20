// The mirror writes that follow no transition: the terminal state of a merged pull request, and the per-poll retry of a failed mirror.
import type { ReadyEntry } from '@/types/actions'
import type { MirrorItemParams, PipelineStateStore, StoredItem } from '@/types/pipeline-state'
import type { WriteOutcome } from '@/types/writes'

const RETRY_LIMIT = 10

interface FinishDeps {
  readonly store: PipelineStateStore
  readonly mirrorItem: (params: MirrorItemParams) => Promise<WriteOutcome>
  readonly auditDir: string
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
    async retryMirrors(entry) {
      const view = deps.store.view(entry.id)
      if (view.kind !== 'store') return
      for (const item of view.items.filter((candidate) => candidate.mirrorFailure !== null).slice(0, RETRY_LIMIT)) await mirror(entry, item, 'mirror-retry', 'state')
    },
  }
}
