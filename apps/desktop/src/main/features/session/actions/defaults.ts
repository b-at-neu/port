import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const sessionDefaults = defineAction({ name: 'session.defaults', kind: 'query', input: noInput, run: (ctx) => ctx.live.hostedStore.defaults() })
