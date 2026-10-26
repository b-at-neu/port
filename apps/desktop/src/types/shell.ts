import type { SessionKey } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'
import type { DispatchOwner } from '@/types/dispatch'
import type { PhaseTone, PillStatus } from '@/types/components'

export interface KeyboardDeps {
  readonly openPalette: (page: 'root') => void
  readonly openNewSessionDialog: () => void
  readonly liveSessionKeys: () => readonly SessionKey[]
  readonly currentSessionKey: () => SessionKey | null
  readonly selectSession: (key: SessionKey) => void
  readonly openNeedsYou: (focus: string | null) => void
  readonly toggleSidebar: () => void
  readonly startRename: () => void
  readonly currentListNavigator: () => { next(): void; prev(): void; open(): void; close?(): void } | undefined
}

export interface PipelineSessionRow {
  readonly key: string
  readonly repoId: RepoId
  readonly number: number
  readonly label: string
  readonly tone: PhaseTone
  /** The dot's screen-reader text: `Needs you`, or the phase name. */
  readonly statusText: string
  /** Non-`null` for a row backed by one of this app's own stage sessions — the row then links to that session, not the board. */
  readonly sessionKey: SessionKey | null
  /** Non-`null` for a detected row (no app-hosted session) — the row then links to that session's live Transcript. Exactly one of `sessionKey`/`transcript` is non-null. */
  readonly transcript: { readonly sessionId: string; readonly agentId: string | null } | null
}

export interface ReadyPipelineRow {
  readonly ready: true
  readonly repoId: RepoId
  readonly name: string
  readonly pill: { readonly status: PillStatus; readonly label: string }
  /** This repository's own cockpit ownership — `'none'` before the first read. */
  readonly owner: DispatchOwner
  readonly unreadableMessage: string | null
  readonly inFlight: number
  readonly needsYou: boolean
  readonly sessions: readonly PipelineSessionRow[]
}

interface NotReadyPipelineRow {
  readonly ready: false
  readonly repoId: RepoId
  readonly name: string
  readonly sessions: readonly PipelineSessionRow[]
}

export type PipelineRow = ReadyPipelineRow | NotReadyPipelineRow
