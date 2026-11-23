// The mirror of `main/app/ipc.ts`'s `registerActions`, over the canned `FixtureHandlers` table instead of a live adapter chain.
import { ipcMain } from 'electron'
import type { FixtureScenario } from '@/types/fixtures'
import { fixtureHandlers } from './handlers'

export function registerFixtureIpc(scenario: FixtureScenario): void {
  const handlers = fixtureHandlers(new Date(), scenario)

  for (const [name, handler] of Object.entries(handlers) as [string, (request: unknown) => unknown][]) {
    ipcMain.handle(name, (_event, request: unknown) => handler(request))
  }

  console.log('[fixtures] serving canned IPC data — no gh or claude calls')
}
