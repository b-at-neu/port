import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const updateState = defineAction({ name: 'update.state', kind: 'query', input: noInput, run: (ctx) => ctx.live.update.service.state() })
