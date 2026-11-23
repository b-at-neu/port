import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveIncidentExport } from '@/main/channels/incidents'

export const incidentsExport = defineAction({
  name: 'incidents.export',
  kind: 'mutation',
  input: z.object({ repoId: repoId.nullable() }),
  run: (ctx, input) => resolveIncidentExport(ctx.repos.deps, input, ctx.seams.incidents),
})
