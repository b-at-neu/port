import type { SessionKey } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'
import type { DispatchOwner } from '@/types/dispatch'
import type { PillStatus } from '@/types/components'

export interface KeyboardDeps {
  readonly openPalette: (page: 'root') => void
  readonly openNewSessionDialog: () => void
  readonly liveSessionKeys: () => readonly SessionKey[]
  readonly currentSessionKey: () => SessionKey | null
  readonly selectSession: (key: SessionKey) => void
  readonly toggleSidebar: () => void
  readonly startRename: () => void
  readonly currentListNavigator: () => { next(): void; prev(): void; open(): void } | undefined
}

export interface PipelineSessionRow {
  readonly key: string
  readonly number: number
  readonly label: string
  readonly dot: 'attention' | 'working' | 'idle'
  /** Non-`null` for a row backed by one of this app's own stage sessions — the row then links to that session, not the board. */
  readonly sessionKey: SessionKey | null
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
}

export type PipelineRow = ReadyPipelineRow | NotReadyPipelineRow
