import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { DispatchControlResult } from '@/types/dispatch'
import type { ToastButton } from '@/types/toast'
import { runStateToast } from '@/renderer/app/run-state-toast'

const repoId = 'r1' as RepoId
const runState = { repoId, state: 'dispatching', since: null } as const
const undo: ToastButton = { label: 'Undo', onClick: () => undefined }
const now = new Date('2026-01-01T00:00:00Z')

const RESULTS: ReadonlyArray<readonly [string, DispatchControlResult, 'success' | 'error' | 'info', boolean]> = [
  ['run ok', { ok: true, command: 'run', repoId, runState }, 'success', true],
  ['run refused', { ok: false, command: 'run', repoId, reason: 'unreadable', message: 'bad' }, 'error', false],
  ['drain ok', { ok: true, command: 'drain', repoId, runState, persisted: true }, 'info', true],
  ['drain not persisted', { ok: true, command: 'drain', repoId, runState, persisted: false }, 'error', false],
  ['pause aborted', { ok: true, command: 'pause', repoId, runState, released: false, report: { kind: 'aborted', reason: 'run-state-unwritable', message: 'denied', path: '/p' } }, 'error', false],
  ['pause completed', { ok: true, command: 'pause', repoId, runState, released: true, report: { kind: 'completed', items: [] } }, 'success', false],
]

describe('runStateToast', () => {
  it.each(RESULTS)('%s, with undo', (_label, result, tone, carriesUndo) => {
    const toast = runStateToast(result, { name: 'o/r', undo, now })
    expect(toast.tone).toBe(tone)
    expect(toast.action !== null).toBe(carriesUndo)
  })

  it.each(RESULTS)('%s, without undo', (_label, result, tone) => {
    const toast = runStateToast(result, { name: 'o/r', undo: null, now })
    expect(toast.tone).toBe(tone)
    expect(toast.action).toBeNull()
  })
})
