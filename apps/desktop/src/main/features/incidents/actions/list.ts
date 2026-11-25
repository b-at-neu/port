import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { scopedIncidents } from '@/main/features/incidents/scope'
import { INCIDENT_LIST_LIMIT, type IncidentListRead } from '@/types/incidents'

export const incidentsList = defineAction({
  name: 'incidents.list',
  kind: 'query',
  input: z.object({ repoId: repoId.nullable(), signature: z.string().min(1).max(199) }),
  run: async (ctx, input): Promise<IncidentListRead> => {
    const { read } = await scopedIncidents(ctx, "'incidents:list'", input.repoId)
    if (!read.ok) return read
    return { ok: true, records: read.records.filter((record) => record.signature === input.signature).slice(-INCIDENT_LIST_LIMIT).reverse(), readAt: read.readAt }
  },
})
