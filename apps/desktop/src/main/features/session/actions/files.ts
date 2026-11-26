import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { readSessionFiles } from '@/main/features/session/resolve'

export const sessionFiles = defineAction({ name: 'session.files', kind: 'query', input: z.object({ sessionKey }), run: (ctx, input) => readSessionFiles(ctx, input) })
