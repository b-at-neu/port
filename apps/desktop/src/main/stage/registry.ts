// stage-sessions.json's only writer: interrupted stage sessions survive a relaunch here. A
// missing or malformed file loads as empty, the same recoverable-state shape as hosting/persist.ts.
import type { InterruptedReason, InterruptedStage } from '../../shared/stage/types'
import type { FileResult } from '../platform/files'

const CURRENT_VERSION = 1

type RegistryState = 'running' | 'interrupted'

interface StoredEntry extends InterruptedStage {
  readonly state: RegistryState
}

interface RegistryFileShape {
  readonly version: number
  readonly entries: readonly unknown[]
}

function isStoredEntry(value: unknown): value is StoredEntry {
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
    (e.state === 'running' || e.state === 'interrupted')
  )
}

export interface CreateStageRegistryParams {
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
}

export interface StageRegistry {
  /** Loads the file, promoting every `running` entry found to `crash` — a `running` record at boot can only mean the process died before it marked itself otherwise. Missing/malformed loads as empty. */
  load(): Promise<readonly InterruptedStage[]>
  recordRunning(entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd'>): void
  setSessionId(id: string, claudeSessionId: string): void
  markInterrupted(id: string, reason: InterruptedReason, detail: string | null, resetsAt: string | null, costUsd: number | null): void
  /** Marks every currently-`running` entry `quit` — called on the quit path before `closeAll()`. */
  markAllQuit(): void
  remove(id: string): void
  list(): readonly InterruptedStage[]
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

  function persist(): void {
    void params.writeJsonAtomic(params.path, { version: CURRENT_VERSION, entries }).then((result) => {
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
    const valid = value.entries.filter(isStoredEntry)
    // Every `running` entry at boot means the process died before it could mark itself otherwise.
    entries = valid.map((e) => (e.state === 'running' ? { ...e, state: 'interrupted', reason: 'crash', detail: null } : e))
    persist()
    return toInterrupted(entries)
  }

  function recordRunning(entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd'>): void {
    entries = [...entries, { ...entry, reason: 'crash', detail: null, resetsAt: null, costUsd: null, state: 'running' }]
    persist()
  }

  function setSessionId(id: string, claudeSessionId: string): void {
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) return
    const next = [...entries]
    const existing = next[idx]
    if (existing === undefined) return
    next[idx] = { ...existing, claudeSessionId }
    entries = next
    persist()
  }

  function markInterrupted(id: string, reason: InterruptedReason, detail: string | null, resetsAt: string | null, costUsd: number | null): void {
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) return
    const next = [...entries]
    const existing = next[idx]
    if (existing === undefined) return
    next[idx] = { ...existing, state: 'interrupted', reason, detail, resetsAt, costUsd }
    entries = next
    persist()
  }

  function markAllQuit(): void {
    entries = entries.map((e) => (e.state === 'running' ? { ...e, state: 'interrupted', reason: 'quit', detail: null } : e))
    persist()
  }

  function remove(id: string): void {
    entries = entries.filter((e) => e.id !== id)
    persist()
  }

  function list(): readonly InterruptedStage[] {
    return toInterrupted(entries.filter((e) => e.state === 'interrupted'))
  }

  return { load, recordRunning, setSessionId, markInterrupted, markAllQuit, remove, list }
}
