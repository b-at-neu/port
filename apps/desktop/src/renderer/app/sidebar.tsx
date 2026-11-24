// The sidebar frame — expanded (248px) or a 48px collapsed rail.
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useSidebarCollapsed, toggleSidebarCollapsed, openNewSessionDialog } from '@/renderer/app/stores'
import { History, PanelLeftClose, PanelLeftOpen, Plus, Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { ScrollArea } from '@/renderer/components/ui/scroll-area'
import { Separator } from '@/renderer/components/ui/separator'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import { repoNeedsYou } from '@/renderer/board/needs-you'
import { useIpcQuery } from '@/renderer/data/query'
import { IconButton } from '@/renderer/components/icon-button'
import { PhaseDot } from '@/renderer/components/phase-dot'
import { NEEDS_YOU_TONE } from '@/renderer/lib/phase-tone'
import { PortMark } from '@/renderer/components/port-mark'
import { SidebarRepos } from '@/renderer/app/sidebar-repos'
import { SidebarFooter } from '@/renderer/app/sidebar-footer'
import { REPO_SCREENS, activeRepoScreen, railRepoOf } from '@/renderer/app/repo-nav-model'
import { isRepoScreenRoute, setSidebarCollapsed, shellPrefs } from '@/renderer/app/prefs'
import { useSidebarSelection } from '@/renderer/app/sidebar-selection'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { UpdateNotice, UpdateRailButton } from '@/renderer/update/notice'
import type { RepoId, RepositoryEntry } from '@/utils/repos'

const RAIL_LINK_CLASS = 'relative flex size-8 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

/** The repository the rail's four icons point at, and its display name. */
function useRailRepo(): { readonly repoId: RepoId; readonly name: string } | null {
  const repos = useIpcQuery('repos.list')
  const sessions = useIpcQuery('session.list')
  const location = useLocation()
  const selection = useSidebarSelection()
  const ready = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const searchRepo = (location.search as { readonly repo?: RepoId | null }).repo ?? null
  const openSession = selection?.kind === 'session' ? (sessions.data ?? []).find((session) => session.sessionKey === selection.sessionKey) : undefined
  const repoId = railRepoOf({
    routeRepo: isRepoScreenRoute(location.pathname) ? searchRepo : null,
    openSessionRepo: openSession?.repoId ?? null,
    lastRepo: shellPrefs().lastRepo,
    readyRepoIds: ready.map((entry) => entry.id),
  })
  const entry = ready.find((candidate) => candidate.id === repoId)
  return repoId === null || entry === undefined ? null : { repoId, name: entry.config.repo }
}

function Rail({ onExpand }: { readonly onExpand: () => void }) {
  const railRepo = useRailRepo()
  const location = useLocation()
  const needsYou = useNeedsYouItems()
  const searchRepo = (location.search as { readonly repo?: RepoId | null }).repo
  const active = activeRepoScreen(location.pathname, searchRepo)
  const needsYouCount = railRepo === null ? 0 : repoNeedsYou(needsYou, railRepo.repoId)

  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 border-r border-border bg-sidebar py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={onExpand} className="flex size-8 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Show sidebar">
            <PanelLeftOpen className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Show sidebar · Ctrl+B</TooltipContent>
      </Tooltip>
      {railRepo !== null ? (
        <div className="mt-2 flex flex-col gap-1">
          {REPO_SCREENS.map(({ key, to, icon: Icon, label }) => (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <Link to={to} search={{ repo: railRepo.repoId }} className={RAIL_LINK_CLASS} aria-label={label} aria-current={active?.repoId === railRepo.repoId && active.screen === key ? 'page' : undefined}>
                  <Icon className="size-4" />
                  {key === 'needsYou' && needsYouCount > 0 ? <PhaseDot tone={NEEDS_YOU_TONE} className="absolute top-1 right-1" /> : null}
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {label} · {railRepo.name}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}
      <div className="flex-1" />
      <UpdateRailButton />
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to={ROUTE_IDS.settings} className="flex size-8 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Settings">
            <Settings className="size-4" />
          </Link>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function Sidebar() {
  const collapsed = useSidebarCollapsed()

  function toggle(): void {
    setSidebarCollapsed(toggleSidebarCollapsed())
  }

  if (collapsed) return <Rail onExpand={toggle} />

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <PortMark />
        <span className="mr-1 flex-1 text-body font-semibold">port</span>
        <IconButton label="New session" tooltip="New session · Ctrl+N" onClick={() => openNewSessionDialog()}>
          <Plus />
        </IconButton>
        <HistoryButton />
        <IconButton label="Hide sidebar" tooltip="Hide sidebar · Ctrl+B" onClick={toggle}>
          <PanelLeftClose />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="py-2">
          <SidebarRepos />
        </div>
      </ScrollArea>
      <UpdateNotice />
      <Separator />
      <SidebarFooter />
    </aside>
  )
}

function HistoryButton() {
  const navigate = useNavigate()
  return (
    <IconButton label="History" tooltip="History" onClick={() => void navigate({ to: ROUTE_IDS.history, search: {} })}>
      <History />
    </IconButton>
  )
}
