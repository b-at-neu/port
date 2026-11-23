import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveIncidentList } from '@/main/channels/incidents'

export const incidentsList = defineAction({
  name: 'incidents.list',
  kind: 'query',
  input: z.object({ repoId: repoId.nullable(), signature: z.string() }),
  run: (ctx, input) => resolveIncidentList(ctx.repos.deps, input, ctx.seams.incidents),
})
