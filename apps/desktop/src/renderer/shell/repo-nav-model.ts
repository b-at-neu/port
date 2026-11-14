// Pure repo-navigation decisions for the sidebar and its rail — which screen a route is, which
// repo the rail shows, and the hash a relaunch restores.
import { Inbox, LayoutDashboard, ListTodo, Tag } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RepoId } from '@/utils/repos'
import type { ActiveRepoScreen, RepoScreenKey } from '@/types/shell'
import { ROUTE_IDS } from '@/renderer/router/routes'

export interface RepoScreenDef {
  readonly key: RepoScreenKey
  readonly to: typeof ROUTE_IDS.board | typeof ROUTE_IDS.needsYou | typeof ROUTE_IDS.backlog | typeof ROUTE_IDS.releases
  readonly label: string
  readonly icon: LucideIcon
}

export const REPO_SCREENS: readonly RepoScreenDef[] = [
  { key: 'board', to: ROUTE_IDS.board, label: 'Board', icon: LayoutDashboard },
  { key: 'needsYou', to: ROUTE_IDS.needsYou, label: 'Needs you', icon: Inbox },
  { key: 'backlog', to: ROUTE_IDS.backlog, label: 'Backlog', icon: ListTodo },
  { key: 'releases', to: ROUTE_IDS.releases, label: 'Releases', icon: Tag },
]

/** `null` for any other route, or for a repo screen the URL does not scope to a repository. */
export function activeRepoScreen(pathname: string, searchRepo: RepoId | null | undefined): ActiveRepoScreen | null {
  if (searchRepo === null || searchRepo === undefined) return null
  const screen = REPO_SCREENS.find((def) => def.to === pathname)
  return screen === undefined ? null : { repoId: searchRepo, screen: screen.key }
}

/** The first candidate that is a ready repository, else the first ready repository. */
export function railRepoOf(input: {
  readonly routeRepo: RepoId | null
  readonly openSessionRepo: RepoId | null
  readonly lastRepo: string | null
  readonly readyRepoIds: readonly RepoId[]
}): RepoId | null {
  const ready = new Set<string>(input.readyRepoIds)
  for (const candidate of [input.routeRepo, input.openSessionRepo, input.lastRepo]) {
    if (candidate !== null && ready.has(candidate)) return candidate as RepoId
  }
  return input.readyRepoIds[0] ?? null
}
