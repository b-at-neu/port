import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const updateCheck = defineAction({ name: 'update.check', kind: 'mutation', input: noInput, run: (ctx) => ctx.live.update.service.check('manual') })
