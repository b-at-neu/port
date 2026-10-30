// session-index.json's only writer: durable history of every app-hosted session, for the Board pane. Never a restore set.
import type { FileResult } from '@/types/platform'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { SessionIndex, SessionIndexEntry } from '@/types/session-index'

const CURRENT_VERSION = 1
export const SESSION_INDEX_CAP = 500

interface IndexFileShape {
  readonly version: number
  readonly entries: readonly unknown[]
}

interface CreateSessionIndexParams {
  readonly path: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isStageTag(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const tag = value as Record<string, unknown>
  return typeof tag.agent === 'string' && typeof tag.number === 'number' && typeof tag.kind === 'string' && typeof tag.trigger === 'string'
}

function isEntry(value: unknown): value is SessionIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.claudeSessionId === 'string' &&
    e.claudeSessionId !== '' &&
    typeof e.startedAt === 'string' &&
    e.startedAt !== '' &&
    isNullableString(e.repoId) &&
    typeof e.cwd === 'string' &&
    isNullableString(e.branch) &&
    isNullableString(e.title) &&
    (e.stage === null || isStageTag(e.stage)) &&
    isNullableString(e.endedAt) &&
    (e.costUsd === null || typeof e.costUsd === 'number') &&
    isNullableString(e.operatorJoinedAt)
  )
}

function capped(entries: readonly SessionIndexEntry[]): SessionIndexEntry[] {
  if (entries.length <= SESSION_INDEX_CAP) return [...entries]
  return [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, SESSION_INDEX_CAP)
}

/** `createSessionIndex({ path, readJson, writeJsonAtomic, now })` — a missing or malformed file loads empty and a write failure keeps the in-memory state, both failing toward fewer past links. */
export function createSessionIndex(params: CreateSessionIndexParams): SessionIndex {
  let entries = new Map<string, SessionIndexEntry>()
  const costBases = new Map<string, number>()
  let writing = false
  let pending: string | null = null
  let lastWritten: string | null = null

  function serialize(): string {
    return JSON.stringify({ version: CURRENT_VERSION, entries: capped([...entries.values()]) })
  }

  function flush(): void {
    const json = serialize()
    if (json === lastWritten) return
    if (writing) {
      pending = json
      return
    }
    writing = true
    void params.writeJsonAtomic(params.path, JSON.parse(json)).then((result) => {
      if (result.ok) lastWritten = json
      else console.error(`[hosting] could not write ${params.path}: ${result.message}`)
      writing = false
      if (pending !== null) {
        const next = pending
        pending = null
        if (next !== lastWritten) flush()
      }
    })
  }

  async function load(): Promise<void> {
    const result = await params.readJson<IndexFileShape>(params.path)
    if (!result.ok) {
      if (result.kind !== 'not-found') console.error(`[hosting] could not read ${params.path}: ${result.message}`)
      return
    }
    const value = result.value
    if (typeof value !== 'object' || value === null || typeof value.version !== 'number' || value.version > CURRENT_VERSION || !Array.isArray(value.entries)) {
      console.error(`[hosting] ${params.path} is malformed or was written by a newer version of Port — starting empty`)
      return
    }
    const loaded = new Map<string, SessionIndexEntry>()
    for (const entry of value.entries.filter(isEntry)) loaded.set(entry.claudeSessionId, entry)
    // Anything observed before the load settled is newer than the file.
    for (const [id, entry] of entries) loaded.set(id, entry)
    entries = loaded
  }

  function observe(snapshot: HostedSessionSnapshot): void {
    const id = snapshot.claudeSessionId
    if (id === null) return
    const existing = entries.get(id)
    if (!costBases.has(snapshot.sessionKey)) costBases.set(snapshot.sessionKey, existing?.costUsd ?? 0)
    const reading = snapshot.usage?.costUsd ?? null
    const costUsd = reading === null ? (existing?.costUsd ?? null) : (costBases.get(snapshot.sessionKey) ?? 0) + reading
    const ended = snapshot.phase === 'ended'
    const next: SessionIndexEntry = {
      claudeSessionId: id,
      repoId: snapshot.repoId,
      cwd: snapshot.workspace.folder,
      branch: snapshot.workspace.worktree?.branch ?? null,
      title: snapshot.title ?? existing?.title ?? null,
      stage: snapshot.stage ?? existing?.stage ?? null,
      startedAt: existing !== undefined && existing.startedAt < snapshot.startedAt ? existing.startedAt : snapshot.startedAt,
      endedAt: ended ? (existing?.endedAt ?? params.now().toISOString()) : null,
      costUsd,
      operatorJoinedAt: existing?.operatorJoinedAt ?? snapshot.operatorJoinedAt,
    }
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(next)) return
    entries.set(id, next)
    flush()
  }

  return { load, observe, list: () => capped([...entries.values()]) }
}
