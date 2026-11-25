import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveSessionCapacity } from '@/main/features/session/resolve'

export const sessionCapacity = defineAction({ name: 'session.capacity', kind: 'query', input: noInput, run: (ctx, input) => resolveSessionCapacity(input, ctx.seams.hosting) })
