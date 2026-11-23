import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const boardSnapshot = defineAction({ name: 'board.snapshot', kind: 'query', input: noInput, run: (ctx) => ctx.live.watcher.snapshot() })
