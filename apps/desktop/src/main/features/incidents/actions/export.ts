import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { scopedIncidents } from '@/main/features/incidents/scope'
import { exportDocument, groupIncidents } from '@/main/pipeline/incidents/group'
import type { IncidentExportResult } from '@/types/incidents'

export const incidentsExport = defineAction({
  name: 'incidents.export',
  kind: 'mutation',
  input: z.object({ repoId: repoId.nullable() }),
  run: async (ctx, input): Promise<IncidentExportResult> => {
    const { slug, read } = await scopedIncidents(ctx, "'incidents:export'", input.repoId)
    if (!read.ok) return { ok: false, kind: 'io', message: read.message }
    const now = ctx.clock.now()
    const path = await ctx.dialogs.chooseSavePath(`port-incidents-${now.toISOString().slice(0, 10)}.json`)
    if (path === null) return { ok: false, kind: 'cancelled' }
    const written = await ctx.fs.writeJsonAtomic(path, exportDocument(groupIncidents(read.records), read, slug, now))
    return written.ok ? { ok: true, path } : { ok: false, kind: 'io', message: written.message }
  },
})
