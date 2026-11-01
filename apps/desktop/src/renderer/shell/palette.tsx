// The command palette (Ctrl/Cmd+K) — Go to, Sessions, Pipelines, View.
import { useNavigate } from '@tanstack/react-router'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/renderer/components/ui/command'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import { sessionTitle } from '@/utils/hosting/label'
import type { RepositoryEntry } from '@/utils/repos'
import { useIpcQuery } from '@/renderer/data/query'
import { selectSession } from '@/renderer/session/actions'
import { useThemePreference } from '@/renderer/theme/store'
import { usePaletteState, closePalette, openNewSessionDialog, setPaletteOpen, toggleSidebarCollapsed } from '@/renderer/shell/stores'
import { useRunStateCommand } from '@/renderer/shell/run-state-command'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { setSidebarCollapsed } from '@/renderer/shell/prefs'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

export function CommandPalette() {
  const { open } = usePaletteState()
  const navigate = useNavigate()
  const snapshot = useIpcQuery('board:snapshot')
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const [, setThemePreference] = useThemePreference()
  const runState = useRunStateCommand()

  const needsYouCount = useNeedsYouItems().length
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const live = (sessions.data ?? []).filter((s) => s.phase !== 'ended')

  function go(to: string): void {
    void navigate({ to })
    closePalette()
  }

  return (
    <CommandDialog open={open} onOpenChange={setPaletteOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => go(ROUTE_IDS.board)}>
            Needs you{needsYouCount > 0 ? ` (${String(needsYouCount)})` : ''}
          </CommandItem>
          <CommandItem onSelect={() => go(ROUTE_IDS.board)}>Board</CommandItem>
          <CommandItem onSelect={() => go(ROUTE_IDS.backlog)}>Backlog</CommandItem>
          <CommandItem onSelect={() => go(ROUTE_IDS.releases)}>Releases</CommandItem>
          <CommandItem
            onSelect={() => {
              void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } })
              closePalette()
            }}
          >
            Repositories
          </CommandItem>
          <CommandItem onSelect={() => go(ROUTE_IDS.settings)}>Settings</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Sessions">
          <CommandItem
            onSelect={() => {
              openNewSessionDialog()
              closePalette()
            }}
          >
            New session
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          {live.map((session) => (
            <CommandItem
              key={session.sessionKey}
              onSelect={() => {
                selectSession(session.sessionKey)
                closePalette()
              }}
            >
              Open {sessionTitle(session)}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => go(ROUTE_IDS.history)}>History…</CommandItem>
          <CommandItem onSelect={() => go(ROUTE_IDS.audit)}>Audit log</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Pipelines">
          {readyRepos.map((repo) => {
            const runStateNow = snapshot.data?.runStates.repositories.find((r) => r.repoId === repo.id)?.state ?? 'paused'
            return (
              <div key={repo.id}>
                {runStateNow !== 'dispatching' ? (
                  <CommandItem
                    onSelect={() => {
                      runState.run(repo.id, repo.config.repo)
                      closePalette()
                    }}
                  >
                    Run {repo.config.repo}
                  </CommandItem>
                ) : null}
                {runStateNow !== 'draining' ? (
                  <CommandItem
                    onSelect={() => {
                      runState.drain(repo.id, repo.config.repo)
                      closePalette()
                    }}
                  >
                    Drain {repo.config.repo}
                  </CommandItem>
                ) : null}
                {runStateNow !== 'paused' ? (
                  <CommandItem
                    onSelect={() => {
                      const inFlight = snapshot.data?.tick.find((t) => t.repoId === repo.id)?.claims.length ?? 0
                      runState.requestPause(repo.id, repo.config.repo, inFlight)
                      closePalette()
                    }}
                  >
                    Pause {repo.config.repo}
                  </CommandItem>
                ) : null}
              </div>
            )
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="View">
          <CommandItem onSelect={() => setThemePreference('system')}>Theme: System</CommandItem>
          <CommandItem onSelect={() => setThemePreference('light')}>Theme: Light</CommandItem>
          <CommandItem onSelect={() => setThemePreference('dark')}>Theme: Dark</CommandItem>
          <CommandItem
            onSelect={() => {
              setSidebarCollapsed(toggleSidebarCollapsed())
              closePalette()
            }}
          >
            Toggle sidebar
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
