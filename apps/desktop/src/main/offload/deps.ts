import type { SearchQueryDeps, SessionsScanDeps, TranscriptTailDeps } from '@/types/channels'
import type { StateEngine } from '@/types/offload'
import { listRepositories } from '@/main/registry'
import { resolveSessionsScan } from '@/main/channels/sessions'
import { createWorkerEngine } from '@/main/offload/client'
import { e2eFakePath } from '@/main/platform/run'

interface OffloadChannelDeps {
  readonly sessionsScan: SessionsScanDeps
  readonly search: SearchQueryDeps
  readonly tail: TranscriptTailDeps
}

/** The one state worker for the process lifetime, spawned on first use, with the channel deps bound to it. */
export function createOffload(options: { readonly onRespawn: () => void }): OffloadChannelDeps & { readonly engine: StateEngine } {
  const engine = createWorkerEngine({ e2eFake: e2eFakePath(), onRespawn: options.onRespawn })
  return { engine, ...offloadChannelDeps(engine) }
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
