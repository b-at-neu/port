// Shared route search-param types for renderer/router/ — multi-file. The route ids and parsers
// themselves stay in renderer/router/routes.ts, the one literal spelling router.tsx reads.
import type { RepoId } from '@/utils/repos'

export interface BoardItemRef {
  readonly repoId: RepoId
  readonly number: number
}

/** Every field optional at the type level — `navigate({ to: ROUTE_IDS.board })`
 *  with no `search` still type-checks. */
export interface BoardSearch {
  readonly item?: BoardItemRef | null
  readonly group?: 'phase' | 'repo'
  readonly repo?: RepoId | null
}

export const SETTINGS_SECTIONS = ['general', 'repositories', 'connections', 'pipeline', 'usage', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** The key is `section`, not `tab`, because `RepoSearch.tab` already owns `tab` with another type across the route tree. */
export interface SettingsSearch {
  readonly section?: SettingsSection
}

type RepoTab = 'overview' | 'worktrees' | 'denials'
export type DenialsGroup = 'command' | 'actor'

export interface RepoSearch {
  readonly tab?: RepoTab
  /** The Denials tab's own tabs-in-tab, persisted so a reload keeps the chosen grouping. Irrelevant outside `tab=denials`, but harmless to carry. Named distinctly from `BoardSearch.group` — TanStack Router's search params are typed across the whole route tree, so two routes sharing a key must share its type. */
  readonly denialsGroup?: DenialsGroup
}

export interface HistorySearch {
  readonly repo?: RepoId | null
  readonly archived?: boolean
}

/** The key is `number`, not `item`, because `BoardSearch.item` already owns `item` with another type across the route tree. `number` only means something alongside `repo`. */
export interface AuditSearch {
  readonly repo?: RepoId | null
  readonly number?: number | null
}

export interface NeedsYouSearch {
  /** The selected row's `dismissKeyOf` key. */
  readonly focus?: string | null
}

export interface SearchSearch {
  readonly repo?: RepoId | null
}

export interface SessionSearch {
  readonly key?: string | null
  /** `pane=changes` opens the Changes pane; anything else reads as closed. */
  readonly pane?: 'changes' | null
}

export interface TranscriptSearch {
  readonly agentId: string | null
  readonly from: 'history' | 'search' | 'board' | 'pipeline'
  readonly focusIndex: number | null
  readonly title: string
  /** The ticket this transcript belongs to — set only from a pipeline sidebar row, so the Transcript screen can show its phase list. `null` elsewhere. */
  readonly item: BoardItemRef | null
}
