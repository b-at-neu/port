import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { readSessionChanges } from '@/main/features/session/resolve'

export const sessionChanges = defineAction({ name: 'session.changes', kind: 'query', input: z.object({ sessionKey }), run: (ctx, input) => readSessionChanges(ctx, input) })
