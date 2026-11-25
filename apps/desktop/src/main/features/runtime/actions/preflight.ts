import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { runtimePreflight } from '@/main/sessions/runtime/preflight'

export const runtimePreflightAction = defineAction({ name: 'runtime.preflight', kind: 'query', input: noInput, run: (ctx) => runtimePreflight(ctx) })
