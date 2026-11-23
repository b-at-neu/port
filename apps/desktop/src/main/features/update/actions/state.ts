import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveUpdateState } from '@/main/features/update/resolve'

export const updateState = defineAction({ name: 'update.state', kind: 'query', input: noInput, run: (ctx, input) => resolveUpdateState(input, ctx.live.update.service) })
