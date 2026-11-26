import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { scanSessions } from '@/main/features/history/scan'

export const historyScan = defineAction({ name: 'history.scan', kind: 'query', input: noInput, run: (ctx) => scanSessions(ctx) })
