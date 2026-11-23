import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const appInfo = defineAction({ name: 'app.info', kind: 'query', input: noInput, run: (ctx) => ctx.info() })
