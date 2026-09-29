// The app-wide drain switch: read, version gate, atomic write — the same
// idiom `main/registry/store.ts` already follows for `registry.json`. Takes
// its directory as a parameter (main passes `app.getPath('userData')`, tests
// pass a `mkdtemp`), so nothing in this module imports Electron.
import { ensureDirectory, pathOps, readJsonFile, writeJsonFileAtomic } from '../platform'
import type { DrainState } from '../../shared/dispatch/types'

const DISPATCH_FILE = 'dispatch.json'
const CURRENT_VERSION = 1

interface DispatchFileShape {
  readonly version: number
  readonly draining: boolean
  readonly since: string | null
}

export type SetDrainResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

export interface DrainStore {
  /** Synchronous, always answerable — starts `{ gate: 'draining', reason:
   *  'unread' }` so a not-yet-`load()`-ed store never reads as open. */
  readonly current: () => DrainState
  /** Resolves the on-disk state once, at startup. */
  readonly load: () => Promise<void>
  /** Writes `draining` atomically, then updates memory — except a failed
   *  `set(true)` still closes the gate in memory (the operator got the stop
   *  they asked for, with the caveat that it will not survive a restart),
   *  while a failed `set(false)` changes nothing at all (a resume that did
   *  not persist would mean the screen and the next launch disagree). */
  readonly set: (draining: boolean, at: string) => Promise<SetDrainResult>
  readonly path: string
}

function dispatchPath(dir: string): string {
  return pathOps.join(dir, DISPATCH_FILE)
}

/** The one place the open arm is ever constructed under this directory
 *  (layer 1's own rail: that construction appears exactly once, so a new
 *  failure path added later cannot quietly fail open by retyping it
 *  instead of reusing this constant). */
const OPEN: DrainState = { gate: 'open' }

function operatorState(since: string): DrainState {
  return { gate: 'draining', reason: 'operator', since }
}

export function createDrainStore(dir: string): DrainStore {
  const path = dispatchPath(dir)
  let state: DrainState = { gate: 'draining', reason: 'unread' }

  return {
    current: () => state,
    path,
    async load(): Promise<void> {
      const result = await readJsonFile<DispatchFileShape>(path)
      if (!result.ok) {
        state = result.kind === 'not-found' ? OPEN : { gate: 'draining', reason: 'unreadable', message: result.message, path }
        return
      }

      const value = result.value
      if (typeof value !== 'object' || value === null || typeof value.draining !== 'boolean') {
        state = { gate: 'draining', reason: 'unreadable', message: `${path} is not a dispatch file`, path }
        return
      }
      if (typeof value.version !== 'number' || value.version > CURRENT_VERSION) {
        state = { gate: 'draining', reason: 'unreadable', message: `${path} was written by a newer version of Port (version ${String(value.version)})`, path }
        return
      }

      state = value.draining ? operatorState(value.since ?? new Date(0).toISOString()) : OPEN
    },
    async set(draining: boolean, at: string): Promise<SetDrainResult> {
      const ensured = await ensureDirectory(dir)
      if (!ensured.ok) {
        if (draining) state = operatorState(at)
        return { ok: false, message: ensured.message }
      }

      const value: DispatchFileShape = { version: CURRENT_VERSION, draining, since: draining ? at : null }
      const written = await writeJsonFileAtomic(path, value)
      if (!written.ok) {
        if (draining) state = operatorState(at)
        return { ok: false, message: written.message }
      }

      state = draining ? operatorState(at) : OPEN
      return { ok: true }
    },
  }
}
