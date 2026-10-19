// Per-repository Backlog label filter, persisted in localStorage; a malformed value reads as no filter.
import type { RepoId } from '@/utils/repos'
import type { BacklogLabelFilter } from '@/types/backlog'
import type { PromptHistoryStorage } from '@/types/session'
import { EMPTY_FILTER, activeCount } from '@/renderer/backlog/filter'

const STORAGE_KEY = 'port.backlogFilters.v1'

type FiltersByRepo = Readonly<Record<string, BacklogLabelFilter>>

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function readAll(storage: PromptHistoryStorage): FiltersByRepo {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, BacklogLabelFilter> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const { include, exclude } = value as Record<string, unknown>
      if (isStringArray(include) && isStringArray(exclude)) out[key] = { include, exclude }
    }
    return out
  } catch {
    return {}
  }
}

export function backlogFilterFor(repoId: RepoId, storage: PromptHistoryStorage = window.localStorage): BacklogLabelFilter {
  return readAll(storage)[repoId] ?? EMPTY_FILTER
}

// An empty filter removes the repository's entry.
export function setBacklogFilter(repoId: RepoId, filter: BacklogLabelFilter, storage: PromptHistoryStorage = window.localStorage): void {
  const others = Object.fromEntries(Object.entries(readAll(storage)).filter(([key]) => key !== repoId))
  const next = activeCount(filter) === 0 ? others : { ...others, [repoId]: filter }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Best-effort only — a full or blocked localStorage loses the filter, never the app.
  }
}
