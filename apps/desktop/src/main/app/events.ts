import { defineEvent } from '@/main/app/define'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot, SessionEntriesDelta } from '@/types/hosting'
import type { AppCommand } from '@/utils/shell/commands'

export const boardUpdate = defineEvent<BoardSnapshot>()('board.update')
/** This app's own typed snapshot, on every phase change — never a delta. */
export const sessionStatus = defineEvent<HostedSessionSnapshot>()('session.status')
/** The live projector's own delta — narrowed, renderer-safe values. */
export const sessionEntries = defineEvent<SessionEntriesDelta>()('session.entries')
/** The app menu's own click, and a notification's own `click`. */
export const appCommand = defineEvent<AppCommand>()('app.command')

export const events = [boardUpdate, sessionStatus, sessionEntries, appCommand] as const

type AnyEvent = (typeof events)[number]

export type EventMap = { [E in AnyEvent as E['name']]: NonNullable<E['payload']> }
export type EventName = keyof EventMap
