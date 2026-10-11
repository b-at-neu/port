// Per-repository prompt history — sent text only, newest first, capped and duplicate-collapsed, persisted in localStorage.
import type { RepoId } from '../../../shared/repos'

export const MAX_ENTRIES = 100

const STORAGE_KEY = 'port.promptHistory.v1'

type HistoryByRepo = Readonly<Record<string, readonly string[]>>

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Injectable so tests exercise this against a plain fake, never a jsdom `window`. */
export interface PromptHistoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): PromptHistoryStorage {
  return window.localStorage
}

function readAll(storage: PromptHistoryStorage): HistoryByRepo {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, readonly string[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isStringArray(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(storage: PromptHistoryStorage, all: HistoryByRepo): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Best-effort only — a full or blocked localStorage loses history, never the app.
  }
}

/** Reads this repository's own history, newest first. */
export function historyFor(repoId: RepoId, storage: PromptHistoryStorage = defaultStorage()): readonly string[] {
  return readAll(storage)[repoId] ?? []
}

/** Prepends `text` unless it equals the newest entry (collapsing consecutive duplicates), capped at `MAX_ENTRIES`. */
export function recordSent(repoId: RepoId, text: string, storage: PromptHistoryStorage = defaultStorage()): void {
  if (text === '') return
  const all = readAll(storage)
  const existing = all[repoId] ?? []
  if (existing[0] === text) return
  const next = [text, ...existing].slice(0, MAX_ENTRIES)
  writeAll(storage, { ...all, [repoId]: next })
}

export interface RecallState {
  /** `null` means not currently recalling — the draft is the operator's own typed text. */
  readonly index: number | null
}

export const NOT_RECALLING: RecallState = { index: null }

/** ↑ moves one entry older, ↓ moves one newer; past the newest returns to `NOT_RECALLING`. */
export function recallOlder(history: readonly string[], state: RecallState): RecallState {
  const next = state.index === null ? 0 : state.index + 1
  return next >= history.length ? state : { index: next }
}

export function recallNewer(state: RecallState): RecallState {
  if (state.index === null || state.index === 0) return NOT_RECALLING
  return { index: state.index - 1 }
}

/** `null` when `state` is not recalling — the caller leaves the draft as
 *  typed. */
export function recallText(history: readonly string[], state: RecallState): string | null {
  return state.index === null ? null : (history[state.index] ?? null)
}
