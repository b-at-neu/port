import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const sessionIndex = defineAction({ name: 'session.index', kind: 'query', input: noInput, run: (ctx) => ctx.stores.sessionIndex.list() })
