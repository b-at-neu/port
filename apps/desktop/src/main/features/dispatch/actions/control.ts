import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveDispatchControl } from '@/main/dispatch/resolve'

/** Run, drain or pause, scoped to one repository. */
export const dispatchControl = defineAction({
  name: 'dispatch.control',
  kind: 'mutation',
  input: z.object({ command: z.enum(['run', 'drain', 'pause']), repoId }),
  run: (ctx, input) => resolveDispatchControl(ctx, input),
})
