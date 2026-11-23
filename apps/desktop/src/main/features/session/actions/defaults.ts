import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveSessionDefaults } from '@/main/channels/hosting'

export const sessionDefaults = defineAction({ name: 'session.defaults', kind: 'query', input: noInput, run: (ctx, input) => resolveSessionDefaults(input, ctx.seams.hosting) })
