import { describe, expect, it, vi } from 'vitest'
import { checkToastOf, noticeOf, statusOf } from '@/renderer/update/model'
import { UPDATE_DISABLED_COPY, UPDATE_ERROR_COPY } from '@/renderer/update/copy'
import type { AvailableRelease, UpdateErrorKind, UpdateState } from '@/types/update'

const NOW = Date.parse('2026-05-01T12:00:00Z')
const CHECKED_AT = '2026-05-01T11:58:00Z'

const RELEASE: AvailableRelease = { version: '0.2.0', tag: 'v0.2.0', notesUrl: 'https://example.test/notes', publishedAt: null, assets: [] }

const STATES: Readonly<Record<UpdateState['kind'], UpdateState>> = {
  disabled: { kind: 'disabled', reason: 'unpackaged', current: '0.1.0' },
  idle: { kind: 'idle', current: '0.1.0' },
  checking: { kind: 'checking', current: '0.1.0', trigger: 'manual', startedAt: CHECKED_AT },
  'up-to-date': { kind: 'up-to-date', current: '0.1.0', latest: '0.1.0', trigger: 'startup', checkedAt: CHECKED_AT },
  available: { kind: 'available', current: '0.1.0', release: RELEASE, trigger: 'startup', checkedAt: CHECKED_AT },
  error: { kind: 'error', current: '0.1.0', reason: 'offline', detail: 'x', trigger: 'startup', checkedAt: CHECKED_AT },
}

const actions = () => ({ update: vi.fn(), retry: vi.fn() })

describe('noticeOf', () => {
  it('is non-null only for an available release, whatever triggered the check', () => {
    expect(noticeOf(STATES.available)).toEqual({ version: '0.2.0', notesUrl: 'https://example.test/notes', release: RELEASE })
    expect(noticeOf({ ...STATES.available, trigger: 'manual' } as UpdateState)?.version).toBe('0.2.0')
  })

  it.each(['disabled', 'idle', 'checking', 'up-to-date', 'error'] as const)('is null for %s', (kind) => {
    expect(noticeOf(STATES[kind])).toBeNull()
  })

  it('is null before the state loads', () => {
    expect(noticeOf(undefined)).toBeNull()
  })
})

describe('statusOf', () => {
  it('maps every kind to its own row', () => {
    expect(statusOf(STATES.disabled, NOW)).toMatchObject({ kind: 'disabled', text: 'Update checks run only in installed builds.', canCheck: false })
    expect(statusOf(STATES.idle, NOW)).toMatchObject({ kind: 'idle', text: 'Not checked yet', canCheck: true })
    expect(statusOf(STATES.checking, NOW)).toMatchObject({ kind: 'checking', text: 'Checking for updates…', canCheck: false })
    expect(statusOf(STATES['up-to-date'], NOW)).toMatchObject({ kind: 'up-to-date', text: 'port is up to date', checkedAgo: '2m ago', canCheck: true })
    expect(statusOf(STATES.available, NOW)).toMatchObject({ kind: 'available', text: 'port 0.2.0 is available', release: RELEASE, canCheck: true })
    expect(statusOf(STATES.error, NOW)).toMatchObject({ kind: 'error', text: UPDATE_ERROR_COPY.offline, canCheck: true })
  })

  it.each(Object.entries(UPDATE_ERROR_COPY) as [UpdateErrorKind, string][])('names the fix for a %s error', (reason, text) => {
    expect(statusOf({ ...STATES.error, reason } as UpdateState, NOW).text).toBe(text)
  })

  it.each(Object.entries(UPDATE_DISABLED_COPY) as [keyof typeof UPDATE_DISABLED_COPY, string][])('explains a %s disable', (reason, text) => {
    expect(statusOf({ kind: 'disabled', reason, current: '0.1.0' }, NOW).text).toBe(text)
  })
})

describe('checkToastOf', () => {
  it('reports up to date as a success with the current version', () => {
    expect(checkToastOf(STATES['up-to-date'], actions())).toMatchObject({ tone: 'success', title: 'port is up to date', description: '0.1.0 is the latest release.', action: null })
  })

  it('reports an available release as info whose Update action starts the update', () => {
    const a = actions()
    const toast = checkToastOf(STATES.available, a)
    expect(toast).toMatchObject({ tone: 'info', title: 'port 0.2.0 is available', description: "You're on 0.1.0." })
    expect(toast?.action?.label).toBe('Update')
    toast?.action?.onClick()
    expect(a.update).toHaveBeenCalledWith(RELEASE)
  })

  it.each(Object.entries(UPDATE_ERROR_COPY) as [UpdateErrorKind, string][])('reports a %s error with Try again', (reason, title) => {
    const a = actions()
    const toast = checkToastOf({ ...STATES.error, reason } as UpdateState, a)
    expect(toast).toMatchObject({ tone: 'error', title })
    expect(toast?.action?.label).toBe('Try again')
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it('reports a disabled build as info with the reason', () => {
    expect(checkToastOf(STATES.disabled, actions())).toMatchObject({ tone: 'info', title: UPDATE_DISABLED_COPY.unpackaged, action: null })
  })

  it.each(['idle', 'checking'] as const)('shows no toast for %s', (kind) => {
    expect(checkToastOf(STATES[kind], actions())).toBeNull()
  })

  it('still reports a startup-triggered result the user asked for', () => {
    expect(checkToastOf(STATES.available, actions())).not.toBeNull()
  })
})
