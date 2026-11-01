import type { SearchQueryDeps, SessionsScanDeps, TranscriptTailDeps } from '@/types/channels'
import type { StateEngine } from '@/types/offload'
import { listRepositories } from '@/main/registry'
import { resolveSessionsScan } from '@/main/channels/sessions'

interface OffloadChannelDeps {
  readonly sessionsScan: SessionsScanDeps
  readonly search: SearchQueryDeps
  readonly tail: TranscriptTailDeps
}

/** The sessions, search and transcript-tail channels' real I/O, bound to the state worker. */
export function offloadChannelDeps(engine: StateEngine): OffloadChannelDeps {
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
