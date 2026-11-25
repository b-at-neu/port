import { describe, expect, it, vi } from 'vitest'
import { closeToast, dismissToast, markToast, sendOutcome, startOutcome, taskStopToast } from '@/renderer/session/outcomes'
import type { SessionDismissResult, SessionKey, SessionMarkResult, SessionSendResult, SessionStartResult, SessionTaskStopResult } from '@/types/hosting'

describe('sendOutcome', () => {
  it.each([
    ['sent', { ok: true, uuid: 'u', queued: false }, { ok: true, error: null, blockedCommandName: null }],
    ['unknown session', { ok: false, kind: 'unknown-session' }, { ok: false, error: 'unknown-session', blockedCommandName: null }],
    ['blocked command', { ok: false, kind: 'blocked-command', name: 'pipeline' }, { ok: false, error: 'blocked-command', blockedCommandName: 'pipeline' }],
    ['unreachable', 'unreachable', { ok: false, error: 'unreachable', blockedCommandName: null }],
  ] as const satisfies readonly (readonly [string, SessionSendResult | 'unreachable', unknown])[])('%s', (_name, result, expected) => {
    expect(sendOutcome(result)).toEqual(expected)
  })
})

describe('startOutcome', () => {
  const key = 'hosted-1' as SessionKey

  it.each([
    ['started', { ok: true, snapshot: {} as never }, 'started'],
    ['already open', { ok: false, kind: 'already-open', sessionKey: key }, 'started'],
    ['at capacity', { ok: false, kind: 'at-capacity', limit: 2 }, 'failed'],
    ['folder busy', { ok: false, kind: 'folder-busy', sessionKey: key }, 'failed'],
    ['folder missing', { ok: false, kind: 'folder-missing', path: null }, 'failed'],
    ['unreachable', 'unreachable', 'failed'],
  ] as const satisfies readonly (readonly [string, SessionStartResult | 'unreachable', string])[])('%s is %s', (_name, result, kind) => {
    expect(startOutcome(result).kind).toBe(kind)
  })

  it('keeps the refused result so the dialog can react to it, and has none for unreachable', () => {
    const refused = { ok: false, kind: 'folder-busy', sessionKey: key } as const
    expect(startOutcome(refused)).toMatchObject({ kind: 'failed', result: refused })
    expect(startOutcome('unreachable')).toMatchObject({ kind: 'failed', result: null })
  })
})

describe('toasts', () => {
  it.each([
    ['closed', { ok: true }, 'success'],
    ['unknown session', { ok: false, kind: 'unknown-session' }, 'error'],
  ] as const)('close: %s is %s', (_name, result, tone) => {
    expect(closeToast(result).tone).toBe(tone)
  })

  it.each([
    ['dismissed', { ok: true }, 'success'],
    ['still open', { ok: false, kind: 'still-open' }, 'error'],
    ['removal failed', { ok: false, kind: 'worktree-remove-failed', message: 'busy' }, 'error'],
    ['dirty worktree', { ok: false, kind: 'worktree-dirty' }, null],
  ] as const satisfies readonly (readonly [string, SessionDismissResult, string | null])[])('dismiss: %s', (_name, result, tone) => {
    expect(dismissToast(result, 'remove')?.tone ?? null).toBe(tone)
  })

  it.each([
    ['stopped', { ok: true }, 'success'],
    ['already finished', { ok: false, kind: 'unknown-task' }, 'info'],
    ['stop failed', { ok: false, kind: 'stop-failed', message: 'x' }, 'error'],
    ['session gone', { ok: false, kind: 'unknown-session' }, 'error'],
  ] as const satisfies readonly (readonly [string, SessionTaskStopResult, string])[])('task stop: %s is %s', (_name, result, tone) => {
    expect(taskStopToast(result).tone).toBe(tone)
  })

  it.each([
    ['marked', { ok: true, marks: { pinned: [], archived: [] } }, 'success', true],
    ['invalid id', { ok: false, kind: 'invalid-session-id' }, 'error', false],
  ] as const satisfies readonly (readonly [string, SessionMarkResult, string, boolean])[])('mark: %s is %s, with Undo %s', (_name, result, tone, undoable) => {
    const undo = vi.fn()
    const toast = markToast('pinned', true, result, undo)
    expect(toast.tone).toBe(tone)
    expect(toast.action !== null).toBe(undoable)
    toast.action?.onClick()
    expect(undo).toHaveBeenCalledTimes(undoable ? 1 : 0)
  })
})
