import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { readGhStatus } from '@/main/features/gh/resolve'

export const ghStatus = defineAction({ name: 'gh.status', kind: 'query', input: noInput, run: (ctx) => readGhStatus(ctx) })
