// #99: the permission dialog's own state and event wiring — an app-wide
// modal that works from `session:status` alone, so it does not depend on
// #219's session view, which is not built yet. The dialog owns its
// `data-action="permission-*"` handling directly, the same idiom `claim/
// controller.ts` and `gate/controller.ts` already establish.
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { HostedSessionSnapshot, PermissionDecision } from '../../../shared/hosting/types'
import { applySnapshot, EMPTY_QUEUE, ordered, seed } from './queue'
import type { PermissionQueue, QueuedPermission } from './queue'
import { documentTitle, IPC_FAILURE_MESSAGE } from './copy'
import { buildPermissionDialog, renderPermissionDialog } from './view'
import type { PermissionDialogProps } from './view'

const ARM_DELAY_MS = 600

let queue: PermissionQueue = EMPTY_QUEUE
let repoLabels = new Map<RepoId, string>()
const repoLabelReloadTried = new Set<RepoId>()
const messages = new Map<string, string>()
const armedAt = new Map<string, number>()
let sending: string | null = null
let sendingDecision: PermissionDecision | null = null
let error: string | null = null
let errorFor: string | null = null

let dialog: HTMLDialogElement | null = null
let lastShownPermissionId: string | null = null
let armTimer: ReturnType<typeof setTimeout> | null = null

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

async function loadRepoLabels(): Promise<void> {
  try {
    const result = await window.port.reposList()
    if (!result.ok) return
    const next = new Map<RepoId, string>()
    for (const entry of result.repositories) next.set(entry.id, isReady(entry) ? entry.config.repo : entry.displayName)
    repoLabels = next
    draw()
  } catch (err) {
    console.error('Failed to load repository labels for the permission dialog', err)
  }
}

/** Falls back to the raw id — reloaded at most once per unresolved id, so a
 *  genuinely unknown repository never triggers a reload loop. */
function repoLabelFor(repoId: RepoId): string {
  const label = repoLabels.get(repoId)
  if (label !== undefined) return label
  if (!repoLabelReloadTried.has(repoId)) {
    repoLabelReloadTried.add(repoId)
    void loadRepoLabels()
  }
  return repoId
}

function current(): QueuedPermission | null {
  return ordered(queue)[0] ?? null
}

function isArmed(permissionId: string): boolean {
  const startedAt = armedAt.get(permissionId)
  return startedAt !== undefined && Date.now() - startedAt >= ARM_DELAY_MS
}

/** Records when a prompt was first shown, so both Allow buttons stay
 *  disabled for `ARM_DELAY_MS` after that — a click meant for something
 *  else, or for a prompt that was just withdrawn, cannot land on Allow. */
function ensureArmed(permissionId: string): void {
  if (armedAt.has(permissionId)) return
  armedAt.set(permissionId, Date.now())
  if (armTimer !== null) clearTimeout(armTimer)
  armTimer = setTimeout(() => {
    armTimer = null
    draw()
  }, ARM_DELAY_MS)
}

/** Nothing dead stays around: a permission no longer in the live queue
 *  (answered, withdrawn, or its session ended) drops its draft message,
 *  its arming timestamp, and — if it was mid-answer — its error state. */
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

function draw(): void {
  const items = ordered(queue)
  document.title = documentTitle(items.length)
  if (!dialog) return

  const item = items[0] ?? null
  if (item === null) {
    renderPermissionDialog(dialog, null, lastShownPermissionId)
    lastShownPermissionId = null
    return
  }

  const permissionId = item.permission.permissionId
  ensureArmed(permissionId)

  const props: PermissionDialogProps = {
    permission: item.permission,
    repoLabel: repoLabelFor(item.repoId),
    sessionKey: item.sessionKey,
    index: 1,
    total: items.length,
    message: messages.get(permissionId) ?? '',
    armed: isArmed(permissionId),
    sending: sending === permissionId ? sendingDecision : null,
    error: errorFor === permissionId ? error : null,
  }
  renderPermissionDialog(dialog, props, lastShownPermissionId)
  lastShownPermissionId = permissionId
}

function applyStatus(snapshot: HostedSessionSnapshot): void {
  queue = applySnapshot(queue, snapshot)
  pruneStaleEntries()
  draw()
}

function setMessage(permissionId: string, value: string): void {
  // Deliberately no draw() here — the textarea already reflects what the
  // operator typed (this fires from its own input event), and nothing else
  // in the dialog depends on the message's content.
  messages.set(permissionId, value)
}

async function answer(item: QueuedPermission, decision: PermissionDecision): Promise<void> {
  const permissionId = item.permission.permissionId
  const message = decision === 'deny' ? (messages.get(permissionId)?.trim() || null) : null

  sending = permissionId
  sendingDecision = decision
  error = null
  errorFor = null
  draw()

  try {
    const response = await window.port.sessionPermissionAnswer({ sessionKey: item.sessionKey, permissionId, decision, message })
    sending = null
    sendingDecision = null
    // A refused answer (unknown-permission / unknown-session / no-session-
    // grant) is an ordinary race — a second window, or a request already
    // withdrawn. The request is dropped from view with no message; the
    // session:status push that raced this call removes it from the queue
    // on its own.
    void response
    draw()
  } catch (err) {
    console.error('Failed to reach the main process while answering a permission request', err)
    sending = null
    sendingDecision = null
    error = IPC_FAILURE_MESSAGE
    errorFor = permissionId
    draw()
  }
}

/** Seeds the queue from the boot-time snapshot list, then subscribes to live
 *  pushes — never the other way around. `initBoard`'s own idiom (main.ts):
 *  awaiting the snapshot to completion before wiring the push listener is
 *  what stops a `session:status` that lands mid-fetch from being clobbered
 *  by the older `sessionList()` result resolving after it — the seed and a
 *  push both fold into `queue` through the same `applySnapshot`, but only
 *  when they land in the order they actually happened. */
async function loadInitialQueue(): Promise<void> {
  try {
    const snapshots = await window.port.sessionList()
    queue = seed(snapshots)
    pruneStaleEntries()
    draw()
  } catch (err) {
    console.error('Failed to load the initial permission queue', err)
  }
  window.port.onSessionStatus((snapshot) => applyStatus(snapshot))
}

/** Appended once to `#app`, outside the board's own signature-guarded
 *  rebuild — a poll landing mid-decision cannot blow away a half-typed deny
 *  reason. */
export function initPermissions(container: HTMLElement): void {
  dialog = buildPermissionDialog()
  container.appendChild(dialog)
  draw()

  void loadInitialQueue()
  void loadRepoLabels()

  dialog.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.action
    const item = current()
    if (item === null) return
    if (action === 'permission-deny') void answer(item, 'deny')
    else if (action === 'permission-allow-once') void answer(item, 'allow-once')
    else if (action === 'permission-allow-session') void answer(item, 'allow-session')
  })

  dialog.addEventListener('input', (event) => {
    const target = event.target
    if (!(target instanceof HTMLTextAreaElement) || target.dataset.field !== 'permission-message') return
    const item = current()
    if (item === null) return
    setMessage(item.permission.permissionId, target.value)
  })

  // A native <dialog>'s own Escape handling fires 'cancel' — denies with
  // the current draft message rather than just hiding the dialog, which
  // would leave the tool blocked with nothing on screen.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    const item = current()
    if (item !== null) void answer(item, 'deny')
  })
}
