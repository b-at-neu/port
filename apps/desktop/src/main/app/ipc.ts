import { ipcMain } from 'electron'
import type { AppContext } from '@/main/app/context'
import { actions } from '@/main/app/router'

/** One handler per router entry: parse the raw request through the action's schema, then run it. A failed parse rejects the invoke. */
export function registerActions(ctx: AppContext): void {
  const seen = new Set<string>()
  for (const action of actions) {
    if (seen.has(action.name)) throw new Error(`action '${action.name}' is defined twice`)
    seen.add(action.name)
    ipcMain.handle(action.name, async (_event, raw: unknown) => {
      try {
        // The union of every action's `run` erases the per-action input type, so the call is cast once here.
        const run = action.run as (ctx: AppContext, input: unknown) => unknown
        return await run(ctx, action.input.parse(raw))
      } catch (error) {
        console.error(`[ipc] ${action.name} failed`, error)
        throw error
      }
    })
  }
}
