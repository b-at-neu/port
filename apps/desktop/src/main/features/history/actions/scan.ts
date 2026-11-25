import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveSessionsScan } from '@/main/features/history/resolve'

export const historyScan = defineAction({ name: 'history.scan', kind: 'query', input: noInput, run: (ctx) => resolveSessionsScan(ctx.repos.deps, ctx.live.offload.sessionsScan) })
