import { describe, expect, it, vi } from 'vitest'
import { checkToastOf, downloadToastOf, downloadViewOf, nextUpdateState, noticeOf, statusOf } from '@/renderer/update/model'
import type { AvailableRelease, InstallPackage, InstallTarget, UpdateDownloadErrorKind, UpdateDownloadState, UpdateErrorKind, UpdateState } from '@/types/update'

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

describe('nextUpdateState', () => {
  const known: readonly (UpdateState | undefined)[] = [STATES.available, STATES.error, undefined]
  const results = ['error', 'up-to-date'] as const
  const cases = known.flatMap((before) => results.map((result) => ({ before, result })))

  it.each(cases)('known $before.kind then $result', ({ before, result }) => {
    const keeps = before?.kind === 'available' && result === 'error'
    expect(nextUpdateState(before, STATES[result])).toBe(keeps ? before : STATES[result])
  })
})

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
  it.each([
    ['disabled', false],
    ['idle', true],
    ['checking', false],
    ['up-to-date', true],
    ['available', true],
    ['error', true],
  ] as const)('%s allows a check: %j', (kind, canCheck) => {
    expect(statusOf(STATES[kind], NOW)).toMatchObject({ kind, canCheck })
  })

  it('reads how long ago an up-to-date check ran, and carries the release when one is available', () => {
    expect(statusOf(STATES['up-to-date'], NOW).checkedAgo).toBe('2m ago')
    expect(statusOf(STATES.available, NOW).release).toBe(RELEASE)
  })
})

describe('checkToastOf', () => {
  it('reports up to date as a success with no action', () => {
    expect(checkToastOf(STATES['up-to-date'], actions())).toMatchObject({ tone: 'success', action: null })
  })

  it('reports an available release as info whose action starts the update', () => {
    const a = actions()
    const toast = checkToastOf(STATES.available, a)
    expect(toast?.tone).toBe('info')
    toast?.action?.onClick()
    expect(a.update).toHaveBeenCalledOnce()
  })

  it.each(['offline', 'rate-limited'] as UpdateErrorKind[])('reports a %s error with an action that retries', (reason) => {
    const a = actions()
    const toast = checkToastOf({ ...STATES.error, reason } as UpdateState, a)
    expect(toast?.tone).toBe('error')
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it('reports a disabled build as info with no action', () => {
    expect(checkToastOf(STATES.disabled, actions())).toMatchObject({ tone: 'info', action: null })
  })

  it.each(['idle', 'checking'] as const)('shows no toast for %s', (kind) => {
    expect(checkToastOf(STATES[kind], actions())).toBeNull()
  })
})

const BASE = { version: '0.2.0', notesUrl: 'https://example.test/notes' }
const MB = 1024 * 1024
const IDLE: UpdateDownloadState = { kind: 'idle' }

function ready(pkg: InstallPackage, opened: 'opened' | 'revealed', openError: string | null = null): UpdateDownloadState {
  return { kind: 'ready', ...BASE, assetName: 'port-0.2.0.x', path: '/d/port-0.2.0.x', package: pkg, opened, openError, finishedAt: CHECKED_AT }
}

const downloading = (receivedBytes: number, totalBytes: number): UpdateDownloadState => ({ kind: 'downloading', ...BASE, assetName: 'port-0.2.0.x', receivedBytes, totalBytes, startedAt: CHECKED_AT })
const failed = (reason: UpdateDownloadErrorKind): UpdateDownloadState => ({ kind: 'failed', ...BASE, assetName: 'port-0.2.0.x', reason, detail: 'x', failedAt: CHECKED_AT })
const NO_ASSET_TARGET: InstallTarget = { os: 'linux', arch: 'arm64', package: 'deb' }
const NO_ASSET: UpdateDownloadState = { kind: 'no-asset', ...BASE, target: NO_ASSET_TARGET }

const RESTARTING: UpdateDownloadState = { kind: 'restarting', ...BASE, startedAt: CHECKED_AT }
const RESTART_PENDING: UpdateDownloadState = { kind: 'restart-pending', ...BASE, finishedAt: CHECKED_AT }

describe('downloadViewOf', () => {
  it.each<UpdateDownloadState | undefined>([undefined, IDLE])('is the available prompt for %j', (download) => {
    expect(downloadViewOf(RELEASE, download)).toMatchObject({ kind: 'idle', railAction: 'download', buttons: [{ action: 'download', variant: 'default' }] })
  })

  it('reads a download for another version as idle', () => {
    expect(downloadViewOf(RELEASE, { ...(downloading(10, 100) as object), version: '0.1.5' } as UpdateDownloadState).kind).toBe('idle')
  })

  it('shows progress while downloading, with no buttons and no rail action', () => {
    expect(downloadViewOf(RELEASE, downloading(54 * MB, 120 * MB))).toMatchObject({ kind: 'downloading', percent: 45, progressText: '54.0 MB of 120.0 MB · 45%', railAction: null, buttons: [] })
  })

  it('has no percent for an unknown total', () => {
    expect(downloadViewOf(RELEASE, downloading(54 * MB, 0))).toMatchObject({ percent: null, progressText: '54.0 MB' })
  })

  it.each([
    [-5, 100, 0],
    [250, 100, 100],
    [1, 3, 33],
  ])('clamps %i of %i to %i percent', (received, total, percent) => {
    expect(downloadViewOf(RELEASE, downloading(received, total)).percent).toBe(percent)
  })

  it.each(['dmg', 'nsis', 'deb'] as const)('offers both buttons once a %s is opened', (pkg) => {
    const view = downloadViewOf(RELEASE, ready(pkg, 'opened'))
    expect(view).toMatchObject({ kind: 'ready', railAction: 'open' })
    expect(view.buttons.map((b) => b.action)).toEqual(['reveal', 'open'])
  })

  it('offers only reveal for an AppImage', () => {
    const view = downloadViewOf(RELEASE, ready('appimage', 'revealed'))
    expect(view.railAction).toBe('reveal')
    expect(view.buttons).toEqual([expect.objectContaining({ action: 'reveal', variant: 'default' })])
  })

  it('offers reveal as the primary button after a failed open', () => {
    const view = downloadViewOf(RELEASE, ready('dmg', 'revealed', 'no application'))
    expect(view.railAction).toBe('reveal')
    expect(view.buttons).toEqual([expect.objectContaining({ action: 'reveal', variant: 'default' })])
  })

  it.each(['interrupted', 'incomplete'] as UpdateDownloadErrorKind[])('offers a retry download after a %s failure', (reason) => {
    expect(downloadViewOf(RELEASE, failed(reason))).toMatchObject({ kind: 'failed', railAction: 'download', buttons: [{ action: 'download', variant: 'default' }] })
  })

  it('shows a restarting state with no buttons, link or rail action', () => {
    expect(downloadViewOf(RELEASE, RESTARTING)).toMatchObject({ kind: 'restarting', railAction: null, linkLabel: null, buttons: [] })
  })

  it('offers a download action once a restart is pending', () => {
    expect(downloadViewOf(RELEASE, RESTART_PENDING)).toMatchObject({ kind: 'restart-pending', railAction: 'download', buttons: [{ action: 'download', variant: 'default' }] })
  })

  it('points a missing asset at the release page, with no buttons', () => {
    expect(downloadViewOf(RELEASE, NO_ASSET)).toMatchObject({ kind: 'no-asset', railAction: 'open-page', buttons: [] })
  })
})

describe('downloadToastOf', () => {
  const toastActions = () => ({ retry: vi.fn(), openPage: vi.fn() })

  it.each<UpdateDownloadState>([IDLE, downloading(1, 2), RESTARTING])('shows no toast for $kind', (state) => {
    expect(downloadToastOf(state, toastActions())).toBeNull()
  })

  it('reports a pending restart as info whose action retries the update', () => {
    const a = toastActions()
    const toast = downloadToastOf(RESTART_PENDING, a)
    expect(toast?.tone).toBe('info')
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it.each([
    [ready('dmg', 'opened'), 'success'],
    [ready('appimage', 'revealed'), 'info'],
  ] as const)('reports %#: an installer as %s', (state, tone) => {
    expect(downloadToastOf(state, toastActions())).toMatchObject({ tone, action: null })
  })

  it.each(['interrupted', 'incomplete'] as UpdateDownloadErrorKind[])('reports a %s failure as an error whose action retries', (reason) => {
    const a = toastActions()
    const toast = downloadToastOf(failed(reason), a)
    expect(toast?.tone).toBe('error')
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it('reports a missing asset as info whose action opens the release page', () => {
    const a = toastActions()
    const toast = downloadToastOf(NO_ASSET, a)
    expect(toast?.tone).toBe('info')
    toast?.action?.onClick()
    expect(a.openPage).toHaveBeenCalledWith('https://example.test/notes')
  })
})
