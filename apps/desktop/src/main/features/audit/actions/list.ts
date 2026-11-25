import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { readAuditLog } from '@/main/github/writes/audit'
import { readyEntryOf } from '@/main/pipeline/context'
import { AUDIT_LIST_LIMIT } from '@/types/writes'

const SUBJECT = "'audit:list'"

const input = z.object({ repoId: repoId.nullable(), number: positiveInt.nullable() }).refine((value) => value.number === null || value.repoId !== null, {
  path: ['number'],
  message: "'number' needs a 'repoId' alongside it",
})

export const auditList = defineAction({
  name: 'audit.list',
  kind: 'query',
  input,
  run: async (ctx, request) => {
    if (request.repoId === null) return readAuditLog(ctx.paths.userData, { limit: AUDIT_LIST_LIMIT })
    const entry = await readyEntryOf(ctx, SUBJECT, request.repoId, (message) => `${SUBJECT} could not list repositories: ${message}`)
    return readAuditLog(ctx.paths.userData, { repo: entry.config.repo, ...(request.number === null ? {} : { number: request.number }), limit: AUDIT_LIST_LIMIT })
  },
})
