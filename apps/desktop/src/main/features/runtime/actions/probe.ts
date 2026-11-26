import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { probeRuntime } from '@/main/features/runtime/resolve'

export const runtimeProbe = defineAction({
  name: 'runtime.probe',
  kind: 'mutation',
  input: z.object({ repoId: repoId.nullable() }),
  run: (ctx, input) => probeRuntime(ctx, input.repoId),
})
