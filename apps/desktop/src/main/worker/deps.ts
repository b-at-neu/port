import type { SearchQueryDeps, SessionsScanDeps, TranscriptTailDeps } from '@/main/app/seams'
import type { StateEngine } from '@/types/offload'
import { listRepositories } from '@/main/repos'
import { resolveSessionsScan } from '@/main/features/history/resolve'
import { createWorkerEngine } from '@/main/worker/client'

interface OffloadChannelDeps {
  readonly sessionsScan: SessionsScanDeps
  readonly search: SearchQueryDeps
  readonly tail: TranscriptTailDeps
}

/** The one state worker for the process lifetime, spawned on first use, with the channel deps bound to it. */
export function createOffload(options: { readonly onRespawn: () => void }): OffloadChannelDeps & { readonly engine: StateEngine; readonly close: () => Promise<void> } {
  const { close, ...engine } = createWorkerEngine({ onRespawn: options.onRespawn })
  return { engine, close, ...offloadChannelDeps(engine) }
}

function offloadChannelDeps(engine: StateEngine): OffloadChannelDeps {
  const sessionsScan: SessionsScanDeps = { listRepositories, readSessionState: ({ repos }) => engine.scanSessions({ repos }) }
  return {
    sessionsScan,
    search: {
      resolveSessionsScan: (registryDeps) => resolveSessionsScan(registryDeps, sessionsScan),
      runSearch: ({ scan, indexDir, query, scope }) => engine.search({ scan, indexDir, query, scope }),
    },
    tail: {
      openTail: (params) => engine.tailOpen(params),
      pollTail: (params) => engine.tailPoll(params),
      closeTail: (params) => void engine.tailClose(params),
    },
  }
}
