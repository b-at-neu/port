// `held:force-dispatch` — the Needs-you "Dispatch anyway" write. Re-reads the watcher's latest
// snapshot and this repository's own dispatch status, never trusting what the renderer already saw.
import type { IpcMap } from '@/types/ipc'
import type { HeldForceDispatchResult } from '@/types/ipc'
import type { HeldChannelDeps } from '@/types/channels'

export function resolveForceDispatch(request: IpcMap['held:force-dispatch']['request'], deps: HeldChannelDeps): HeldForceDispatchResult {
  if (typeof request?.repoId !== 'string' || request.repoId === '') throw new Error("'held:force-dispatch' requires a non-empty 'repoId'")
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'held:force-dispatch' requires 'number' to be a positive integer")
  }

  const { repoId, number } = request
  const owner = deps.dispatcherStatus().find((s) => s.repoId === repoId)?.owner ?? 'none'
  if (owner !== 'app') return { kind: 'not-owned' }

  const report = deps.snapshot().tick.find((t) => t.repoId === repoId)
  const held = report?.held.find((h) => h.number === number)
  if (held === undefined || held.reason !== 'contended') return { kind: 'not-held' }

  deps.forceDispatch.set(repoId, number)
  deps.republish()
  return { kind: 'ok' }
}
