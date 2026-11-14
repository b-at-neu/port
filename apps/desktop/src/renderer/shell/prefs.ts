// A malformed field falls back to its default rather than throwing — a
// hand-edited or stale value must never crash the app on launch.
import { RESTORABLE_ROUTES, ROUTE_IDS } from '@/renderer/router/routes'

interface ShellPrefs {
  readonly v: 1
  readonly sidebarCollapsed: boolean
  readonly collapsedRepos: readonly string[]
  readonly lastRoute: string | null
  readonly lastRepo: string | null
  readonly selectedSession: string | null
}

const STORAGE_KEY = 'port.shell'

const DEFAULT_PREFS: ShellPrefs = {
  v: 1,
  sidebarCollapsed: false,
  collapsedRepos: [],
  lastRoute: null,
  lastRepo: null,
  selectedSession: null,
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function parseShellPrefs(raw: string | null): ShellPrefs {
  if (raw === null) return DEFAULT_PREFS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS
    const value = parsed as Record<string, unknown>
    return {
      v: 1,
      sidebarCollapsed: typeof value.sidebarCollapsed === 'boolean' ? value.sidebarCollapsed : DEFAULT_PREFS.sidebarCollapsed,
      collapsedRepos: isStringArray(value.collapsedRepos) ? value.collapsedRepos : DEFAULT_PREFS.collapsedRepos,
      lastRoute: typeof value.lastRoute === 'string' && RESTORABLE_ROUTES.includes(value.lastRoute) ? value.lastRoute : DEFAULT_PREFS.lastRoute,
      lastRepo: typeof value.lastRepo === 'string' && value.lastRepo !== '' ? value.lastRepo : DEFAULT_PREFS.lastRepo,
      selectedSession: typeof value.selectedSession === 'string' ? value.selectedSession : DEFAULT_PREFS.selectedSession,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function shellPrefs(): ShellPrefs {
  return parseShellPrefs(window.localStorage.getItem(STORAGE_KEY))
}

function writePrefs(next: ShellPrefs): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function setSidebarCollapsed(collapsed: boolean): void {
  writePrefs({ ...shellPrefs(), sidebarCollapsed: collapsed })
}

export function setRepoCollapsed(repoId: string, collapsed: boolean): void {
  const prefs = shellPrefs()
  const without = prefs.collapsedRepos.filter((id) => id !== repoId)
  writePrefs({ ...prefs, collapsedRepos: collapsed ? [...without, repoId] : without })
}

export function setSelectedSession(claudeSessionId: string | null): void {
  writePrefs({ ...shellPrefs(), selectedSession: claudeSessionId })
}

export function setLastRepo(repoId: string): void {
  writePrefs({ ...shellPrefs(), lastRepo: repoId })
}

const REPO_SCREEN_ROUTES: readonly string[] = [ROUTE_IDS.board, ROUTE_IDS.needsYou, ROUTE_IDS.backlog, ROUTE_IDS.releases]

/** Whether `pathname` is one of the four screens a `?repo=` scopes. */
export function isRepoScreenRoute(pathname: string): boolean {
  return REPO_SCREEN_ROUTES.includes(pathname)
}

/** The hash a launch restores: a repo screen keeps its repository, any other route restores bare. */
export function restoreHashOf(prefs: Pick<ShellPrefs, 'lastRoute' | 'lastRepo'>): string | null {
  if (prefs.lastRoute === null) return null
  if (prefs.lastRepo !== null && isRepoScreenRoute(prefs.lastRoute)) return `#${prefs.lastRoute}?repo=${encodeURIComponent(prefs.lastRepo)}`
  return `#${prefs.lastRoute}`
}

/** Only a `RESTORABLE_ROUTES` pathname is persisted — a transient route never becomes the restore target. */
export function trackLastRoute(pathname: string): void {
  if (!RESTORABLE_ROUTES.includes(pathname)) return
  writePrefs({ ...shellPrefs(), lastRoute: pathname })
}
