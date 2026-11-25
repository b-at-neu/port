import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const reposList = defineAction({ name: 'repos.list', kind: 'query', input: noInput, run: (ctx) => ctx.repos.list() })
