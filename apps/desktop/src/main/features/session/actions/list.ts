import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const sessionList = defineAction({ name: 'session.list', kind: 'query', input: noInput, run: (ctx) => ctx.live.hostedStore.list() })
