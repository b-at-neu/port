import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const notifyPrefs = defineAction({ name: 'notify.prefs', kind: 'query', input: noInput, run: (ctx) => ctx.live.hostedStore.notificationPrefs() })
