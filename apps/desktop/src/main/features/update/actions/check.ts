import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveUpdateCheck } from '@/main/features/update/resolve'

export const updateCheck = defineAction({ name: 'update.check', kind: 'mutation', input: noInput, run: (ctx, input) => resolveUpdateCheck(input, ctx.live.update.service) })
