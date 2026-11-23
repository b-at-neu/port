import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { haltDispatch } from '@/main/dispatch/halt'
import { releaseOwnership, takeOwnership } from '@/main/dispatch/ownership'
import { resolveDispatchControl } from '@/main/dispatch/resolve'
import { listRepositories } from '@/main/registry'

/** Run, drain or pause, scoped to one repository. */
export const dispatchControl = defineAction({
  name: 'dispatch.control',
  kind: 'mutation',
  input: z.object({ command: z.enum(['run', 'drain', 'pause']), repoId }),
  run: (ctx, input) =>
    resolveDispatchControl(ctx.repos.deps, input, {
      listRepositories,
      runStates: ctx.stores.runStates,
      haltDispatch: (params) =>
        haltDispatch(params, {
          applyItemAction: ctx.live.actions.applyItemAction,
          stopFor: (id, number) => ctx.live.dispatcher.stopFor(id, number),
          standDown: (id) => ctx.live.dispatcher.standDown(id),
        }),
      takeOwnership,
      releaseOwnership,
      snapshot: ctx.live.watcher.snapshot,
      refresh: ctx.live.watcher.refresh,
      auditDir: ctx.paths.userData,
      now: () => new Date(),
    }),
})
