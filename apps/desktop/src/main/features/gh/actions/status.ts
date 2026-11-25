import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveGhStatus } from '@/main/features/gh/resolve'

export const ghStatus = defineAction({ name: 'gh.status', kind: 'query', input: noInput, run: (_ctx, input) => resolveGhStatus(input) })
