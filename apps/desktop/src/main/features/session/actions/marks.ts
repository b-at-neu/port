import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const sessionMarks = defineAction({ name: 'session.marks', kind: 'query', input: noInput, run: (ctx) => ctx.live.hostedStore.marks() })
