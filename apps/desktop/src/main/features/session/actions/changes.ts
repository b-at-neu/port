import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionChanges } from '@/main/channels/workspace'

export const sessionChanges = defineAction({ name: 'session.changes', kind: 'query', input: z.object({ sessionKey }), run: (ctx, input) => resolveSessionChanges(input, ctx.seams.workspace) })
