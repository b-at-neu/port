import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveSessionList } from '@/main/channels/hosting'

export const sessionList = defineAction({ name: 'session.list', kind: 'query', input: noInput, run: (ctx, input) => resolveSessionList(input, ctx.seams.hosting) })
