import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const usageSummary = defineAction({ name: 'usage.summary', kind: 'query', input: noInput, run: (ctx) => ctx.stores.usageLedger.summary() })
