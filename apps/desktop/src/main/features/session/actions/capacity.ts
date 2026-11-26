import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const sessionCapacity = defineAction({ name: 'session.capacity', kind: 'query', input: noInput, run: (ctx) => ctx.live.hostedStore.capacity() })
