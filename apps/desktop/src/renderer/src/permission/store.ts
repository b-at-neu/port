// The permission dialog's queue, arming, drafts and sending state.
// `createPermissionStore` is the injectable, directly-testable factory.
import { useSyncExternalStore } from 'react'
import type { HostedSessionSnapshot, PermissionDecision, SessionPermissionAnswerResult } from '../../../shared/hosting/types'
import { applySnapshot, EMPTY_QUEUE, interactionCount, ordered, seed } from './queue'
import type { PermissionQueue, QueuedPermission } from './queue'
import { IPC_FAILURE_MESSAGE } from './copy'
import { invoke } from '../data/invoke'
import { sharedSubscriptions } from '../data/subscriptions'

const ARM_DELAY_MS = 600

export interface PermissionViewState {
  readonly current: QueuedPermission | null
  readonly total: number
  readonly message: string
  readonly armed: boolean
  readonly sending: PermissionDecision | null
  readonly error: string | null
}

const EMPTY_STATE: PermissionViewState = { current: null, total: 0, message: '', armed: false, sending: null, error: null }

function documentTitleFor(count: number): string {
  if (count === 0) return 'port'
  return `port — ${String(count)} permission request${count === 1 ? '' : 's'} waiting`
}

export interface PermissionStoreDeps {
  readonly answerPermission: (params: { readonly sessionKey: QueuedPermission['sessionKey']; readonly permissionId: string; readonly decision: PermissionDecision; readonly message: string | null }) => Promise<SessionPermissionAnswerResult>
  readonly sessionList: () => Promise<readonly HostedSessionSnapshot[]>
  readonly subscribeSessionStatus: (listener: (snapshot: HostedSessionSnapshot) => void) => () => void
  readonly now: () => number
  readonly setDocumentTitle: (title: string) => void
}

export interface PermissionStore {
  subscribe(this: void, listener: () => void): () => void
  getSnapshot(this: void): PermissionViewState
  setMessage(permissionId: string, value: string): void
  answer(item: QueuedPermission, decision: PermissionDecision): Promise<void>
}

/** Injectable so `store.test.ts` can drive arming/pruning deterministically —
 *  a fake clock, no real IPC, no real `document`. */
export function createPermissionStore(deps: PermissionStoreDeps): PermissionStore {
  let queue: PermissionQueue = EMPTY_QUEUE
  const messages = new Map<string, string>()
  const armedAt = new Map<string, number>()
  let sending: string | null = null
  let sendingDecision: PermissionDecision | null = null
  let error: string | null = null
  let errorFor: string | null = null
  let armTimer: ReturnType<typeof setTimeout> | null = null
  let snapshot: PermissionViewState = EMPTY_STATE
  const listeners = new Set<() => void>()
  let initialized = false

  function isArmed(permissionId: string): boolean {
    const startedAt = armedAt.get(permissionId)
    return startedAt !== undefined && deps.now() - startedAt >= ARM_DELAY_MS
  }

  /** Both Allow buttons stay disabled for `ARM_DELAY_MS` after a prompt first
   *  shows — a click meant for something else cannot land on Allow. */
  function ensureArmed(permissionId: string): void {
    if (armedAt.has(permissionId)) return
    armedAt.set(permissionId, deps.now())
    if (armTimer !== null) clearTimeout(armTimer)
    armTimer = setTimeout(() => {
      armTimer = null
      notify()
    }, ARM_DELAY_MS)
  }

  function pruneStaleEntries(): void {
    const liveIds = new Set(ordered(queue).map((item) => item.permission.permissionId))
    for (const id of [...messages.keys()]) if (!liveIds.has(id)) messages.delete(id)
    for (const id of [...armedAt.keys()]) if (!liveIds.has(id)) armedAt.delete(id)
    if (sending !== null && !liveIds.has(sending)) {
      sending = null
      sendingDecision = null
    }
    if (errorFor !== null && !liveIds.has(errorFor)) {
      error = null
      errorFor = null
    }
  }

  function notify(): void {
    const items = ordered(queue)
    const item = items[0] ?? null
    if (item === null) {
      snapshot = EMPTY_STATE
    } else {
      const permissionId = item.permission.permissionId
      ensureArmed(permissionId)
      snapshot = {
        current: item,
        total: items.length,
        message: messages.get(permissionId) ?? '',
        armed: isArmed(permissionId),
        sending: sending === permissionId ? sendingDecision : null,
        error: errorFor === permissionId ? error : null,
      }
    }
    // A question/plan card counts toward "N waiting" even though it never appears in `items`.
    deps.setDocumentTitle(documentTitleFor(items.length + interactionCount(queue)))
    for (const listener of listeners) listener()
  }

  function initPermissionQueue(): void {
    if (initialized) return
    initialized = true

    void deps
      .sessionList()
      .then((snapshots) => {
        queue = seed(snapshots)
        pruneStaleEntries()
        notify()
      })
      .catch((err: unknown) => {
        console.error('Failed to load the initial permission queue', err)
      })

    deps.subscribeSessionStatus((status) => {
      queue = applySnapshot(queue, status)
      pruneStaleEntries()
      notify()
    })
  }

  return {
    getSnapshot: () => snapshot,
    setMessage(permissionId, value) {
      messages.set(permissionId, value)
    },
    async answer(item, decision) {
      const permissionId = item.permission.permissionId
      const message = decision === 'deny' ? (messages.get(permissionId)?.trim() || null) : null

      sending = permissionId
      sendingDecision = decision
      error = null
      errorFor = null
      notify()

      try {
        await deps.answerPermission({ sessionKey: item.sessionKey, permissionId, decision, message })
        sending = null
        sendingDecision = null
        notify()
      } catch (err) {
        console.error('Failed to reach the main process while answering a permission request', err)
        sending = null
        sendingDecision = null
        error = IPC_FAILURE_MESSAGE
        errorFor = permissionId
        notify()
      }
    },
    subscribe(listener) {
      initPermissionQueue()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

let shared: PermissionStore | null = null

function sharedStore(): PermissionStore {
  shared ??= createPermissionStore({
    answerPermission: (params) => invoke('session:permission:answer', params),
    sessionList: () => window.port.sessionList(),
    subscribeSessionStatus: (listener) => sharedSubscriptions().subscribe('session:status', listener),
    now: () => Date.now(),
    setDocumentTitle: (title) => {
      document.title = title
    },
  })
  return shared
}

export function setMessage(permissionId: string, value: string): void {
  sharedStore().setMessage(permissionId, value)
}

export async function answer(item: QueuedPermission, decision: PermissionDecision): Promise<void> {
  await sharedStore().answer(item, decision)
}

export function usePermissionState(): PermissionViewState {
  const store = sharedStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
