// Rebuilds the app menu's "Go to session" submenu from the hosted store's own sessions and marks —
// one composition so the initial build, onStatus, dismiss, and pin/archive all share the same dedupe.
import { Menu } from 'electron'
import type { HostedStore } from '@/types/hosting'
import type { AppCommand } from '@/utils/shell/commands'
import { menuTemplate } from '@/main/menu'
import { orderSessions } from '@/utils/shell/session-order'
import { sessionTitle } from '@/utils/hosting/label'

export interface SessionMenuRefresherDeps {
  readonly store: HostedStore
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  readonly send: (command: AppCommand) => void
}

export interface SessionMenuRefresher {
  readonly refresh: () => void
  /** Runs `refresh` only when the awaited result is `ok` — the dismiss/pin/archive channels' own shape. */
  readonly withRefresh: <T extends { readonly ok: boolean }>(result: Promise<T>) => Promise<T>
}

/** Builds the initial menu once, on construction — callers never need a separate first call. */
export function createSessionMenuRefresher(deps: SessionMenuRefresherDeps): SessionMenuRefresher {
  let lastSignature: string | null = null

  function refresh(): void {
    void deps.store.marks().then((marks) => {
      const ordered = orderSessions(deps.store.list(), marks).map((snapshot) => ({ label: sessionTitle(snapshot), sessionKey: snapshot.sessionKey }))
      const signature = ordered.map((entry) => `${entry.label}|${entry.sessionKey}`).join('\n')
      if (signature === lastSignature) return
      lastSignature = signature
      Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(deps.platform, deps.isPackaged, ordered, deps.send)))
    })
  }

  function withRefresh<T extends { readonly ok: boolean }>(result: Promise<T>): Promise<T> {
    return result.then((value) => {
      if (value.ok) refresh()
      return value
    })
  }

  refresh()
  return { refresh, withRefresh }
}
