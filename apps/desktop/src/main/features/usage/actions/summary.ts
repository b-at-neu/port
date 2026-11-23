import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveUsageSummary } from '@/main/channels/storage'

export const usageSummary = defineAction({ name: 'usage.summary', kind: 'query', input: noInput, run: (ctx, input) => resolveUsageSummary(input, ctx.stores.usageLedger) })
