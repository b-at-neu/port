// The command palette (Ctrl/Cmd+K) — Go to, Sessions, Pipelines, Tickets, View.
import { useNavigate } from '@tanstack/react-router'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'
import { needsYouItems } from '../../../shared/board/needs-you'
import { sessionTitle } from '../../../shared/hosting/label'
import type { RepositoryEntry } from '../../../shared/repos'
import { useIpcQuery } from '../data/query'
import { startNewSession, selectSession } from '../session/actions'
import { openClaimDialog } from '../claim/controller'
import { useThemePreference } from '../theme/store'
import { usePaletteState, closePalette, setPaletteOpen, toggleSidebarCollapsed } from './stores'
import { useRunStateCommand } from './run-state-command'
import { ROUTE_IDS } from '../router/routes'
import { setSidebarCollapsed } from './prefs'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

export function CommandPalette() {
  const { open, page } = usePaletteState()
  const navigate = useNavigate()
  const snapshot = useIpcQuery('board:snapshot')
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const [, setThemePreference] = useThemePreference()
  const runState = useRunStateCommand()

  const needsYouCount = snapshot.data !== undefined ? needsYouItems(snapshot.data, new Date()).length : 0
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const live = (sessions.data ?? []).filter((s) => s.phase !== 'ended')

  function go(to: string): void {
    void navigate({ to })
    closePalette()
  }

  if (page === 'new-session') {
    return (
      <CommandDialog open={open} onOpenChange={setPaletteOpen}>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          <CommandGroup heading="New session">
            {readyRepos.map((repo) => (
              <CommandItem
                key={repo.id}
                onSelect={() => {
                  startNewSession(repo.id)
                  closePalette()
                }}
              >
                New session in {repo.config.repo}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    )
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
          <CommandItem onSelect={() => go(ROUTE_IDS.repos)}>Repositories</CommandItem>
          <CommandItem onSelect={() => go(ROUTE_IDS.settings)}>Settings</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Sessions">
          {readyRepos.length === 1 ? (
            <CommandItem
              onSelect={() => {
                startNewSession(readyRepos[0]!.id)
                closePalette()
              }}
            >
              New session
              <CommandShortcut>⌘N</CommandShortcut>
            </CommandItem>
          ) : null}
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
        <CommandGroup heading="Tickets">
          <CommandItem
            onSelect={() => {
              closePalette()
              openClaimDialog()
            }}
          >
            Work on ticket…
          </CommandItem>
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
