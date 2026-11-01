// Renderer-safe contracts for the Settings screen's own reads and writes.
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { UsageTotals } from '@/utils/hosting/usage'
import type { RepoId } from '@/utils/repos'

/** Both default to on, so a lost file never silences a real wait. */
export interface NotificationPrefs {
  /** "When something needs you" — Needs you items that just appeared. */
  readonly needsYou: boolean
  /** "When your own sessions finish or need permission". */
  readonly sessions: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { needsYou: true, sessions: true }

/** One connection's line in the Connections tab and the status popover. */
export interface ConnectionLine {
  readonly key: string
  readonly label: string
  readonly state: string
  /** `checked 2m ago`; `null` when the state already carries its own age. */
  readonly age: string | null
  readonly tone: 'success' | 'attention' | 'danger' | 'idle'
}

/** A failed read is data, never a rejection, and never `0` — an empty reading is not a zero. */
export type SizeRead = { readonly ok: true; readonly bytes: number; readonly truncated: boolean } | { readonly ok: false; readonly message: string }

export interface StorageEntry {
  readonly label: string
  readonly path: string
  readonly size: SizeRead
}

export interface StorageReport {
  readonly appData: readonly StorageEntry[]
  readonly pluginCache: StorageEntry
  readonly worktrees: readonly (StorageEntry & { readonly repoId: RepoId })[]
}

/** One hosted handle's cumulative reading, keyed `<bootId>:<sessionKey>` — a `SessionKey` restarts at `hosted-1` every launch. */
export interface UsageRecord {
  readonly id: string
  readonly repoId: RepoId | null
  readonly lastAt: string
  readonly costUsd: number | null
  readonly tokens: number | null
}

export interface UsageRow {
  /** `null` for sessions outside any registered repository. */
  readonly repoId: RepoId | null
  readonly today: UsageTotals
  readonly week: UsageTotals
  readonly month: UsageTotals
}

export interface UsageLedger {
  load(): Promise<void>
  /** Upserts the handle's record when its cost or token sum changed; a snapshot with no usage reading is ignored. */
  observe(snapshot: HostedSessionSnapshot): void
  summary(): UsageSummary
}

export interface UsageSummary {
  readonly rows: readonly UsageRow[]
  /** The oldest record's instant — `null` with no records at all. */
  readonly since: string | null
}
