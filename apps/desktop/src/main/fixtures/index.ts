// The mirror of `main/ipc.ts`'s `registerIpc`, over the canned `FixtureHandlers` table instead of a live adapter chain.
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcChannel } from '../../shared/ipc'
import type { FixtureScenario } from './mode'
import { fixtureHandlers } from './handlers'

export function registerFixtureIpc(scenario: FixtureScenario): void {
  const handlers = fixtureHandlers(new Date(), scenario)
  const registered = new Set<IpcChannel>()

  for (const channel of IPC_CHANNELS) {
    registered.add(channel)
    // The one cast this file needs: the loop erases `handlers[channel]`'s per-key type to the union `IpcChannel`.
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
