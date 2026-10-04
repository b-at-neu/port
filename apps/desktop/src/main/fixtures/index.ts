// Fixture mode's own IPC registrar (#317) — the mirror of `main/ipc.ts`'s
// `registerIpc`, over the canned `FixtureHandlers` table instead of a live
// adapter chain. No watcher, no hosted-session store, no drain store: every
// request this process ever answers comes from `fixtureHandlers` alone.
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcChannel } from '../../shared/ipc'
import { fixtureHandlers } from './handlers'

export function registerFixtureIpc(): void {
  const handlers = fixtureHandlers(new Date())
  const registered = new Set<IpcChannel>()

  for (const channel of IPC_CHANNELS) {
    registered.add(channel)
    // The one cast this file needs: `handlers[channel]` is exact per key, but
    // this loop erases that to the union `IpcChannel`, the same trade
    // `main/ipc.ts`'s own generic `handle<C>` makes for the live registrar.
    const handler = handlers[channel] as (request: unknown) => unknown
    ipcMain.handle(channel, (_event, request: unknown) => handler(request))
  }

  for (const channel of IPC_CHANNELS) {
    if (!registered.has(channel)) {
      throw new Error(`IPC channel '${channel}' is declared but has no fixture handler`)
    }
  }

  console.log('[fixtures] serving canned IPC data — no gh or claude calls')
}
