import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveSessionMarks } from '@/main/channels/hosting'

export const sessionMarks = defineAction({ name: 'session.marks', kind: 'query', input: noInput, run: (ctx, input) => resolveSessionMarks(input, ctx.seams.hosting) })
