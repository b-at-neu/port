// The permission dialog's queue, arming, drafts and sending state, notified
// through `useSyncExternalStore`. `queue.ts` stays the pure fold.
import { useSyncExternalStore } from 'react'
import type { PermissionDecision } from '../../../shared/hosting/types'
import { applySnapshot, EMPTY_QUEUE, ordered, seed } from './queue'
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

function isArmed(permissionId: string): boolean {
  const startedAt = armedAt.get(permissionId)
  return startedAt !== undefined && Date.now() - startedAt >= ARM_DELAY_MS
}

/** Both Allow buttons stay disabled for `ARM_DELAY_MS` after a prompt first
 *  shows — a click meant for something else cannot land on Allow. */
function ensureArmed(permissionId: string): void {
  if (armedAt.has(permissionId)) return
  armedAt.set(permissionId, Date.now())
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
  document.title = documentTitleFor(items.length)
  for (const listener of listeners) listener()
}

function documentTitleFor(count: number): string {
  if (count === 0) return 'port'
  return `port — ${String(count)} permission request${count === 1 ? '' : 's'} waiting`
}

export function setMessage(permissionId: string, value: string): void {
  messages.set(permissionId, value)
}

export async function answer(item: QueuedPermission, decision: PermissionDecision): Promise<void> {
  const permissionId = item.permission.permissionId
  const message = decision === 'deny' ? (messages.get(permissionId)?.trim() || null) : null

  sending = permissionId
  sendingDecision = decision
  error = null
  errorFor = null
  notify()

  try {
    await invoke('session:permission:answer', { sessionKey: item.sessionKey, permissionId, decision, message })
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
}

let initialized = false

/** Seeds the queue, then subscribes to live pushes — never the other way around. */
export function initPermissionQueue(): void {
  if (initialized) return
  initialized = true

  void window.port
    .sessionList()
    .then((snapshots) => {
      queue = seed(snapshots)
      pruneStaleEntries()
      notify()
    })
    .catch((err: unknown) => {
      console.error('Failed to load the initial permission queue', err)
    })

  sharedSubscriptions().subscribe('session:status', (status) => {
    queue = applySnapshot(queue, status)
    pruneStaleEntries()
    notify()
  })
}

function subscribe(listener: () => void): () => void {
  initPermissionQueue()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): PermissionViewState {
  return snapshot
}

export function usePermissionState(): PermissionViewState {
  return useSyncExternalStore(subscribe, getSnapshot)
}
