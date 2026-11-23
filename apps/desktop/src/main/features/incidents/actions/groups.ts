import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveIncidentGroups } from '@/main/channels/incidents'

export const incidentsGroups = defineAction({
  name: 'incidents.groups',
  kind: 'query',
  input: z.object({ repoId: repoId.nullable() }),
  run: (ctx, input) => resolveIncidentGroups(ctx.repos.deps, input, ctx.seams.incidents),
})
