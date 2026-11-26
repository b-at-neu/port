import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { restoreList } from '@/main/features/session/resolve'

export const sessionRestoreList = defineAction({ name: 'session.restoreList', kind: 'query', input: noInput, run: (ctx) => restoreList(ctx) })
