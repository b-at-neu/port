import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveSessionIndex } from '@/main/features/session/resolve'

export const sessionIndex = defineAction({ name: 'session.index', kind: 'query', input: noInput, run: (ctx, input) => resolveSessionIndex(input, ctx.seams.hosting) })
