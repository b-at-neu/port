import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { scopedIncidents } from '@/main/features/incidents/scope'
import { groupIncidents } from '@/main/pipeline/incidents/group'
import type { IncidentGroupsRead } from '@/types/incidents'

export const incidentsGroups = defineAction({
  name: 'incidents.groups',
  kind: 'query',
  input: z.object({ repoId: repoId.nullable() }),
  run: async (ctx, input): Promise<IncidentGroupsRead> => {
    const { read } = await scopedIncidents(ctx, "'incidents:groups'", input.repoId)
    return read.ok ? { ok: true, groups: groupIncidents(read.records), malformed: read.malformed, pruned: read.pruned, readAt: read.readAt } : read
  },
})
