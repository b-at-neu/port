// #103: the restore banner's own state and actions — split out of
// session/controller.ts to stay under the file-size limit (ENGINEERING §7).
// Every write ends in `onChange()`, always `controller.ts`'s own `draw`,
// passed in rather than imported, so this module stays free of any
// dependency back on the controller.
import type { HostedSessionSnapshot, RestorableSession, SessionKey } from '../../../shared/hosting/types'
import { restorePartialLine } from './rail-copy'
import { startFailureCopy } from './copy'

export interface RestoreState {
  readonly entries: readonly RestorableSession[]
  readonly reviewing: boolean
  readonly notice: string | null
}

let entries: readonly RestorableSession[] = []
let reviewing = false
let notice: string | null = null

export function restoreState(): RestoreState {
  return { entries, reviewing, notice }
}

export function toggleReviewing(onChange: () => void): void {
  reviewing = !reviewing
  onChange()
}

export async function loadRestoreList(onChange: () => void): Promise<void> {
  try {
    const result = await window.port.sessionRestoreList()
    entries = result.entries
    onChange()
  } catch (err) {
    console.error('Failed to load the restore list', err)
  }
}

export interface RestoreOneCallbacks {
  readonly onStarted: (snapshot: HostedSessionSnapshot) => void
  readonly onAlreadyOpen: (sessionKey: SessionKey) => void
  readonly onChange: () => void
}

export async function resumeOne(restoreId: string, callbacks: RestoreOneCallbacks): Promise<void> {
  try {
    const result = await window.port.sessionRestore({ restoreId })
    entries = entries.filter((entry) => entry.restoreId !== restoreId)
    if (result.ok) {
      callbacks.onStarted(result.snapshot)
    } else if (result.kind === 'already-open') {
      callbacks.onAlreadyOpen(result.sessionKey)
    } else if (result.kind === 'at-capacity') {
      notice = `Port is already hosting ${String(result.limit)} sessions — the limit. Close one or raise the limit to resume this one.`
    } else if (result.kind === 'repo-unavailable') {
      notice = `This repository isn't ready — ${result.reason}`
    } else if (result.kind === 'runtime') {
      notice = startFailureCopy(result).body
    }
  } catch (err) {
    console.error('Failed to reach the main process restoring a session', err)
  }
  callbacks.onChange()
}

/** Resumes every available entry sequentially, in list order, stopping at
 *  the first `at-capacity` — the rest stay listed, per the plan's own UX
 *  state. */
export async function resumeAll(adopt: (snapshot: HostedSessionSnapshot) => void, onChange: () => void): Promise<void> {
  const candidates = entries.filter((entry) => entry.availability.ok)
  let resumed = 0
  for (const entry of candidates) {
    try {
      const result = await window.port.sessionRestore({ restoreId: entry.restoreId })
      entries = entries.filter((candidate) => candidate.restoreId !== entry.restoreId)
      if (result.ok) {
        resumed += 1
        adopt(result.snapshot)
      } else if (result.kind === 'already-open') {
        resumed += 1
      } else if (result.kind === 'at-capacity') {
        notice = restorePartialLine(resumed, candidates.length, result.limit)
        onChange()
        return
      }
    } catch (err) {
      console.error('Failed to reach the main process resuming a session', err)
      onChange()
      return
    }
  }
  onChange()
}

export async function forget(restoreId: string, onChange: () => void): Promise<void> {
  try {
    await window.port.sessionRestoreDiscard({ restoreId })
    entries = entries.filter((entry) => entry.restoreId !== restoreId)
  } catch (err) {
    console.error('Failed to reach the main process forgetting a restorable session', err)
  }
  onChange()
}

export async function dismissBanner(onChange: () => void): Promise<void> {
  try {
    await window.port.sessionRestoreDiscard({ restoreId: null })
    entries = []
    reviewing = false
  } catch (err) {
    console.error('Failed to reach the main process dismissing the restore banner', err)
  }
  onChange()
}
