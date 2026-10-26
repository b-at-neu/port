// Sends one OS notification per read that brought new items into Needs you. Main owns the focus rule.
import type { QueryClient } from '@tanstack/react-query'
import { needsYouItems } from '@/renderer/board/needs-you'
import { invoke } from '@/renderer/data/invoke'
import { ipcQueryOptions, observeIpcQuery } from '@/renderer/data/query'
import { dismissedKeys, visibleItems } from '@/renderer/needs-you/dismissed'
import { diffNeedsYou, displayNamesOf, needsYouNotification, readableRepoIds } from '@/renderer/needs-you/notify-model'
import type { BoardSnapshot, NeedsYouBaseline } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { IpcMap } from '@/types/ipc'

const STORAGE_KEY = 'port.needsYouNotified.v1'

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

interface NeedsYouNotifierDeps {
  readonly storage: KeyValueStore
  readonly send: (request: IpcMap['notify:needs-you']['request']) => Promise<void>
  readonly dismissed: () => ReadonlySet<string>
  readonly now: () => Date
}

function isKeyList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((key) => typeof key === 'string')
}

/** A missing or malformed value is `null`, which seeds silently. */
function readBaseline(storage: KeyValueStore): NeedsYouBaseline | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const entries = Object.entries(parsed)
    return entries.every(([, keys]) => isKeyList(keys)) ? (parsed as NeedsYouBaseline) : null
  } catch {
    return null
  }
}

function writeBaseline(storage: KeyValueStore, baseline: NeedsYouBaseline): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(baseline))
  } catch (error) {
    console.error('Could not persist the Needs you notification baseline', error)
  }
}

export function createNeedsYouNotifier(deps: NeedsYouNotifierDeps): { readonly evaluate: (snapshot: BoardSnapshot, sessions: readonly HostedSessionSnapshot[]) => void } {
  return {
    evaluate(snapshot, sessions) {
      const items = visibleItems(needsYouItems(snapshot, deps.now(), sessions), deps.dismissed())
      const { baseline, fresh } = diffNeedsYou(readBaseline(deps.storage), items, readableRepoIds(snapshot))
      writeBaseline(deps.storage, baseline)
      const notification = needsYouNotification(fresh, displayNamesOf(snapshot))
      if (notification === null) return
      deps.send(notification).catch((error: unknown) => console.error('Could not send the Needs you notification', error))
    },
  }
}

export function connectNeedsYouNotifications(client: QueryClient): () => void {
  const notifier = createNeedsYouNotifier({
    storage: window.localStorage,
    send: (request) => invoke('notify:needs-you', request),
    dismissed: dismissedKeys,
    now: () => new Date(),
  })

  function evaluate(): void {
    const snapshot = client.getQueryData(ipcQueryOptions('board:snapshot').queryKey)
    const sessions = client.getQueryData(ipcQueryOptions('session:list').queryKey)
    if (snapshot !== undefined && sessions !== undefined) notifier.evaluate(snapshot, sessions)
  }

  const stops = [
    observeIpcQuery(client, 'board:snapshot', undefined, (result) => {
      if (result.status === 'success') evaluate()
    }),
    observeIpcQuery(client, 'session:list', undefined, (result) => {
      if (result.status === 'success') evaluate()
    }),
  ]
  return () => stops.forEach((stop) => stop())
}
