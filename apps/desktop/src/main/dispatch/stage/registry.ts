// stage-sessions.json's only writer: interrupted stage sessions survive a relaunch here. A
// missing or malformed file loads as empty, the same recoverable-state shape as hosting/persist.ts.
import { z } from 'zod'
import { createJsonStore } from '@/main/platform/json-store'
import type { InterruptedReason, InterruptedStage } from '@/types/stage'
import type { FileResult } from '@/types/platform'
import type { StageRegistry } from '@/types/stage'
import { NETWORK_BACKOFF_MS } from '@/main/dispatch/stage/stale'

const CURRENT_VERSION = 1

type RegistryState = 'running' | 'interrupted'

interface StoredEntry extends InterruptedStage {
  readonly state: RegistryState
}

/** An old file's entry carries no `interruptedAt` or `networkRetries`. */
type RawEntry = Omit<StoredEntry, 'interruptedAt' | 'networkRetries'> & { readonly interruptedAt?: string; readonly networkRetries?: number }

const registryFileSchema = z.object({ version: z.literal(CURRENT_VERSION), entries: z.array(z.unknown()) })

function isRawEntry(value: unknown): value is RawEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    e.id !== '' &&
    typeof e.repoId === 'string' &&
    typeof e.agent === 'string' &&
    typeof e.number === 'number' &&
    typeof e.kind === 'string' &&
    typeof e.trigger === 'string' &&
    typeof e.inFlight === 'string' &&
    typeof e.model === 'string' &&
    (e.claudeSessionId === null || typeof e.claudeSessionId === 'string') &&
    typeof e.worktree === 'object' &&
    e.worktree !== null &&
    typeof e.startedAt === 'string' &&
    (e.interruptedAt === undefined || typeof e.interruptedAt === 'string') &&
    (e.state === 'running' || e.state === 'interrupted')
  )
}

/** Keeps the last occurrence of each id, in file order — the newest append wins. */
function dedupedById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return items.filter((item, index) => items.findLastIndex((other) => other.id === item.id) === index)
}

interface CreateStageRegistryParams {
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
}

function toInterrupted(entries: readonly StoredEntry[]): readonly InterruptedStage[] {
  return entries.map(
    (e): InterruptedStage => ({
      id: e.id,
      repoId: e.repoId,
      agent: e.agent,
      number: e.number,
      kind: e.kind,
      trigger: e.trigger,
      inFlight: e.inFlight,
      model: e.model,
      title: e.title,
      claudeSessionId: e.claudeSessionId,
      worktree: e.worktree,
      startedAt: e.startedAt,
      interruptedAt: e.interruptedAt,
      reason: e.reason,
      detail: e.detail,
      resetsAt: e.resetsAt,
      costUsd: e.costUsd,
      networkRetries: e.networkRetries,
    }),
  )
}

/** `createStageRegistry({ path, readJson, writeJsonAtomic, now })` — a write failure is logged and the in-memory state is kept, which fails toward showing the item this run. */
export function createStageRegistry(params: CreateStageRegistryParams): StageRegistry {
  const store = createJsonStore({
    file: params.path,
    version: CURRENT_VERSION,
    schema: registryFileSchema,
    initial: { version: CURRENT_VERSION, entries: [] },
    unreadable: 'reset',
    fs: { readJson: params.readJson, writeJsonAtomic: params.writeJsonAtomic },
  })
  let entries: StoredEntry[] = []

  function persist(): Promise<void> {
    return store.write({ version: CURRENT_VERSION, entries }).then((result) => {
      if (!result.ok) console.error(`[stage] could not write ${params.path}: ${result.message}`)
    })
  }

  async function load(): Promise<readonly InterruptedStage[]> {
    await store.load()
    if (store.status().kind === 'unreadable') {
      entries = []
      return []
    }
    const loadedAt = params.now().toISOString()
    // Every `running` entry at boot means the process died before it could mark itself otherwise.
    entries = dedupedById(store.value().entries.filter(isRawEntry)).map((e): StoredEntry => {
      const { title, ...rest } = e
      const stamped = { ...rest, ...(typeof title === 'string' ? { title } : {}), interruptedAt: e.interruptedAt ?? loadedAt, networkRetries: typeof e.networkRetries === 'number' ? e.networkRetries : 0 }
      return e.state === 'running' ? { ...stamped, state: 'interrupted', reason: 'crash', detail: null } : stamped
    })
    void persist()
    return toInterrupted(entries)
  }

  function recordRunning(entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd' | 'interruptedAt' | 'networkRetries'>): void {
    const next: StoredEntry = { ...entry, interruptedAt: entry.startedAt, reason: 'crash', detail: null, resetsAt: null, costUsd: null, networkRetries: 0, state: 'running' }
    entries = [...entries.filter((e) => e.id !== entry.id), next]
    void persist()
  }

  function markRunning(id: string): void {
    const idx = entries.findIndex((e) => e.id === id)
    const existing = entries[idx]
    if (existing === undefined) return
    const next = [...entries]
    next[idx] = { ...existing, state: 'running', reason: 'crash', detail: null, resetsAt: null, costUsd: null, networkRetries: existing.reason === 'network' ? existing.networkRetries + 1 : existing.networkRetries }
    entries = next
    void persist()
  }

  function setSessionId(id: string, claudeSessionId: string): void {
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) return
    const next = [...entries]
    const existing = next[idx]
    if (existing === undefined) return
    next[idx] = { ...existing, claudeSessionId }
    entries = next
    void persist()
  }

  function markInterrupted(id: string, reason: InterruptedReason, detail: string | null, resetsAt: string | null, costUsd: number | null): void {
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) return
    const next = [...entries]
    const existing = next[idx]
    if (existing === undefined) return
    const at = params.now()
    const networkRetries = reason === 'network' ? existing.networkRetries : 0
    const due = reason === 'network' ? new Date(at.getTime() + (NETWORK_BACKOFF_MS[Math.min(networkRetries, NETWORK_BACKOFF_MS.length - 1)] ?? 0)).toISOString() : resetsAt
    next[idx] = { ...existing, state: 'interrupted', reason, detail, resetsAt: due, costUsd, networkRetries, interruptedAt: at.toISOString() }
    entries = next
    void persist()
  }

  function markAllQuit(): Promise<void> {
    const at = params.now().toISOString()
    entries = entries.map((e) => (e.state === 'running' ? { ...e, state: 'interrupted', reason: 'quit', detail: null, interruptedAt: at } : e))
    return persist()
  }

  function remove(id: string): void {
    entries = entries.filter((e) => e.id !== id)
    void persist()
  }

  function list(): readonly InterruptedStage[] {
    return toInterrupted(entries.filter((e) => e.state === 'interrupted'))
  }

  function running(): readonly InterruptedStage[] {
    return toInterrupted(entries.filter((e) => e.state === 'running'))
  }

  return { load, recordRunning, markRunning, setSessionId, markInterrupted, markAllQuit, remove, list, running }
}
