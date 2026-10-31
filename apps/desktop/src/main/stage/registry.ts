// stage-sessions.json's only writer: interrupted stage sessions survive a relaunch here. A
// missing or malformed file loads as empty, the same recoverable-state shape as hosting/persist.ts.
import type { InterruptedReason, InterruptedStage } from '@/types/stage'
import type { FileResult } from '@/types/platform'
import type { StageRegistry } from '@/types/stage'

const CURRENT_VERSION = 1

type RegistryState = 'running' | 'interrupted'

interface StoredEntry extends InterruptedStage {
  readonly state: RegistryState
}

/** An old file's entry carries no `interruptedAt`. */
type RawEntry = Omit<StoredEntry, 'interruptedAt'> & { readonly interruptedAt?: string }

interface RegistryFileShape {
  readonly version: number
  readonly entries: readonly unknown[]
}

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
      claudeSessionId: e.claudeSessionId,
      worktree: e.worktree,
      startedAt: e.startedAt,
      interruptedAt: e.interruptedAt,
      reason: e.reason,
      detail: e.detail,
      resetsAt: e.resetsAt,
      costUsd: e.costUsd,
    }),
  )
}

/** `createStageRegistry({ path, readJson, writeJsonAtomic, now })` — a write failure is logged and the in-memory state is kept, which fails toward showing the item this run. */
export function createStageRegistry(params: CreateStageRegistryParams): StageRegistry {
  let entries: StoredEntry[] = []

  function persist(): Promise<void> {
    return params.writeJsonAtomic(params.path, { version: CURRENT_VERSION, entries }).then((result) => {
      if (!result.ok) console.error(`[stage] could not write ${params.path}: ${result.message}`)
    })
  }

  async function load(): Promise<readonly InterruptedStage[]> {
    const result = await params.readJson<RegistryFileShape>(params.path)
    if (!result.ok) {
      entries = []
      return []
    }
    const value = result.value
    if (typeof value !== 'object' || value === null || !Array.isArray(value.entries)) {
      entries = []
      return []
    }
    const loadedAt = params.now().toISOString()
    // Every `running` entry at boot means the process died before it could mark itself otherwise.
    entries = dedupedById(value.entries.filter(isRawEntry)).map((e): StoredEntry => {
      const stamped = { ...e, interruptedAt: e.interruptedAt ?? loadedAt }
      return e.state === 'running' ? { ...stamped, state: 'interrupted', reason: 'crash', detail: null } : stamped
    })
    void persist()
    return toInterrupted(entries)
  }

  function recordRunning(entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd' | 'interruptedAt'>): void {
    const next: StoredEntry = { ...entry, interruptedAt: entry.startedAt, reason: 'crash', detail: null, resetsAt: null, costUsd: null, state: 'running' }
    entries = [...entries.filter((e) => e.id !== entry.id), next]
    void persist()
  }

  function markRunning(id: string): void {
    const idx = entries.findIndex((e) => e.id === id)
    const existing = entries[idx]
    if (existing === undefined) return
    const next = [...entries]
    next[idx] = { ...existing, state: 'running', reason: 'crash', detail: null, resetsAt: null, costUsd: null }
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
    next[idx] = { ...existing, state: 'interrupted', reason, detail, resetsAt, costUsd, interruptedAt: params.now().toISOString() }
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

  return { load, recordRunning, markRunning, setSessionId, markInterrupted, markAllQuit, remove, list }
}
