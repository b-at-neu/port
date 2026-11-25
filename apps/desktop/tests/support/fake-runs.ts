import type { InterruptedStage, RunStore } from '@/types/stage'
import { NETWORK_BACKOFF_MS } from '@/utils/pipeline/ticket'

type Held = InterruptedStage & { state: 'running' | 'interrupted' }

export type NewRun = Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd' | 'interruptedAt' | 'networkRetries'>

/** The run reads and writes the sweeper uses, held in memory and applied the instant they are called, so a sweep test can arrange and read runs without awaiting a store. */
export function createFakeRuns(now: () => Date) {
  let held: Held[] = []
  const find = (id: string) => held.find((entry) => entry.id === id)
  const replace = (id: string, next: Partial<Held>) => {
    held = held.map((entry) => (entry.id === id ? { ...entry, ...next } : entry))
  }

  const runs: Pick<RunStore, 'list' | 'running' | 'cleared' | 'interrupt'> = {
    list: () => held.filter((entry) => entry.state === 'interrupted'),
    running: () => held.filter((entry) => entry.state === 'running'),
    cleared: (_repoId, id) => {
      held = held.filter((entry) => entry.id !== id)
      return Promise.resolve()
    },
    interrupt: (_repoId, id, interruption) => {
      const existing = find(id)
      if (existing === undefined) return Promise.resolve()
      const at = now()
      const retries = interruption.reason === 'network' ? existing.networkRetries : 0
      const backoff = NETWORK_BACKOFF_MS[Math.min(retries, NETWORK_BACKOFF_MS.length - 1)] ?? 0
      replace(id, { state: 'interrupted', reason: interruption.reason, detail: interruption.detail, resetsAt: interruption.reason === 'network' ? new Date(at.getTime() + backoff).toISOString() : interruption.resetsAt, costUsd: interruption.costUsd ?? existing.costUsd, networkRetries: retries, interruptedAt: at.toISOString() })
      return Promise.resolve()
    },
  }

  return {
    ...runs,
    recordRunning: (entry: NewRun) => {
      held = [...held.filter((e) => e.id !== entry.id), { ...entry, interruptedAt: entry.startedAt, reason: 'crash', detail: null, resetsAt: null, costUsd: null, networkRetries: 0, state: 'running' }]
    },
    markRunning: (id: string) => {
      const existing = find(id)
      if (existing !== undefined) replace(id, { state: 'running', reason: 'crash', detail: null, resetsAt: null, networkRetries: existing.reason === 'network' ? existing.networkRetries + 1 : existing.networkRetries })
    },
    markAllQuit: () => {
      held = held.map((entry) => (entry.state === 'running' ? { ...entry, state: 'interrupted', reason: 'quit', interruptedAt: now().toISOString() } : entry))
    },
  }
}
