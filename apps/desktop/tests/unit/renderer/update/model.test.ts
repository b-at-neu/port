import { describe, expect, it, vi } from 'vitest'
import { checkToastOf, downloadToastOf, downloadViewOf, noticeOf, statusOf } from '@/renderer/update/model'
import {
  UPDATE_BUTTON_LABEL,
  UPDATE_CHECKING,
  UPDATE_DISABLED_COPY,
  UPDATE_DOWNLOAD_FAILED_COPY,
  UPDATE_ERROR_COPY,
  UPDATE_NOT_CHECKED,
  UPDATE_NOTES_LABEL,
  UPDATE_OPEN_FAILED_HINT,
  UPDATE_OPEN_LABEL,
  UPDATE_OPEN_PAGE_LABEL,
  UPDATE_READY_HINT,
  UPDATE_RESTARTING_HINT,
  UPDATE_RESTART_LABEL,
  UPDATE_RESTART_PENDING_HINT,
  UPDATE_RETRY_LABEL,
  UPDATE_REVEAL_LABEL,
  UPDATE_UP_TO_DATE,
  updateAvailableTitle,
  updateCurrentDescription,
  updateDownloadedTitle,
  updateDownloadingRailLabel,
  updateDownloadingTitle,
  updateLatestDescription,
  updateNoAssetCopy,
  updateRailLabel,
  updateRestartPendingTitle,
  updateRestartingTitle,
} from '@/renderer/update/copy'
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
    expect(statusOf(STATES.disabled, NOW)).toMatchObject({ kind: 'disabled', text: UPDATE_DISABLED_COPY.unpackaged, canCheck: false })
    expect(statusOf(STATES.idle, NOW)).toMatchObject({ kind: 'idle', text: UPDATE_NOT_CHECKED, canCheck: true })
    expect(statusOf(STATES.checking, NOW)).toMatchObject({ kind: 'checking', text: UPDATE_CHECKING, canCheck: false })
    expect(statusOf(STATES['up-to-date'], NOW)).toMatchObject({ kind: 'up-to-date', text: UPDATE_UP_TO_DATE, checkedAgo: '2m ago', canCheck: true })
    expect(statusOf(STATES.available, NOW)).toMatchObject({ kind: 'available', text: updateAvailableTitle('0.2.0'), release: RELEASE, canCheck: true })
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
    expect(checkToastOf(STATES['up-to-date'], actions())).toMatchObject({ tone: 'success', title: UPDATE_UP_TO_DATE, description: updateLatestDescription('0.1.0'), action: null })
  })

  it('reports an available release as info whose Update action starts the update', () => {
    const a = actions()
    const toast = checkToastOf(STATES.available, a)
    expect(toast).toMatchObject({ tone: 'info', title: updateAvailableTitle('0.2.0'), description: updateCurrentDescription('0.1.0') })
    expect(toast?.action?.label).toBe(UPDATE_BUTTON_LABEL)
    toast?.action?.onClick()
    expect(a.update).toHaveBeenCalledOnce()
  })

  it.each(Object.entries(UPDATE_ERROR_COPY) as [UpdateErrorKind, string][])('reports a %s error with Try again', (reason, title) => {
    const a = actions()
    const toast = checkToastOf({ ...STATES.error, reason } as UpdateState, a)
    expect(toast).toMatchObject({ tone: 'error', title })
    expect(toast?.action?.label).toBe(UPDATE_RETRY_LABEL)
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
    expect(downloadViewOf(RELEASE, download)).toMatchObject({
      kind: 'idle',
      title: updateAvailableTitle('0.2.0'),
      railLabel: updateRailLabel('0.2.0'),
      railAction: 'download',
      linkLabel: UPDATE_NOTES_LABEL,
      buttons: [{ action: 'download', label: UPDATE_BUTTON_LABEL, variant: 'default' }],
    })
  })

  it('reads a download for another version as idle', () => {
    expect(downloadViewOf(RELEASE, { ...(downloading(10, 100) as object), version: '0.1.5' } as UpdateDownloadState).kind).toBe('idle')
  })

  it('shows progress while downloading, with no buttons and no rail action', () => {
    const view = downloadViewOf(RELEASE, downloading(54 * MB, 120 * MB))
    expect(view).toMatchObject({ kind: 'downloading', title: updateDownloadingTitle('0.2.0'), percent: 45, progressText: '54.0 MB of 120.0 MB · 45%', railAction: null, buttons: [], linkLabel: UPDATE_NOTES_LABEL })
    expect(view.railLabel).toBe(updateDownloadingRailLabel('0.2.0', 45))
  })

  it('has no percent for an unknown total', () => {
    const view = downloadViewOf(RELEASE, downloading(54 * MB, 0))
    expect(view).toMatchObject({ percent: null, progressText: '54.0 MB', railLabel: updateDownloadingRailLabel('0.2.0', null) })
  })

  it.each([
    [-5, 100, 0],
    [250, 100, 100],
    [1, 3, 33],
  ])('clamps %i of %i to %i percent', (received, total, percent) => {
    expect(downloadViewOf(RELEASE, downloading(received, total)).percent).toBe(percent)
  })

  it.each(['dmg', 'nsis', 'deb'] as const)('offers both buttons and the %s hint once opened', (pkg) => {
    expect(downloadViewOf(RELEASE, ready(pkg, 'opened'))).toMatchObject({
      kind: 'ready',
      title: updateDownloadedTitle('0.2.0'),
      hint: UPDATE_READY_HINT[pkg],
      railAction: 'open',
      buttons: [
        { action: 'reveal', label: UPDATE_REVEAL_LABEL, variant: 'outline' },
        { action: 'open', label: UPDATE_OPEN_LABEL, variant: 'default' },
      ],
    })
  })

  it('offers only Show in folder for an AppImage, with its own hint', () => {
    expect(downloadViewOf(RELEASE, ready('appimage', 'revealed'))).toMatchObject({
      hint: UPDATE_READY_HINT.appimage,
      railAction: 'reveal',
      buttons: [{ action: 'reveal', label: UPDATE_REVEAL_LABEL, variant: 'default' }],
    })
  })

  it('explains a failed open and offers Show in folder', () => {
    expect(downloadViewOf(RELEASE, ready('dmg', 'revealed', 'no application'))).toMatchObject({
      hint: UPDATE_OPEN_FAILED_HINT,
      railAction: 'reveal',
      buttons: [{ action: 'reveal', variant: 'default' }],
    })
  })

  it.each(Object.keys(UPDATE_DOWNLOAD_FAILED_COPY) as UpdateDownloadErrorKind[])('names the %s reason and offers Try again and the release page', (reason) => {
    const text = UPDATE_DOWNLOAD_FAILED_COPY[reason]('0.2.0')
    expect(downloadViewOf(RELEASE, failed(reason))).toMatchObject({
      kind: 'failed',
      title: updateAvailableTitle('0.2.0'),
      hint: text,
      railLabel: text,
      railAction: 'download',
      linkLabel: UPDATE_OPEN_PAGE_LABEL,
      buttons: [{ action: 'download', label: UPDATE_RETRY_LABEL, variant: 'default' }],
    })
  })

  it('shows a restarting state with no buttons, link or rail action', () => {
    expect(downloadViewOf(RELEASE, RESTARTING)).toMatchObject({
      kind: 'restarting',
      title: updateRestartingTitle('0.2.0'),
      hint: UPDATE_RESTARTING_HINT,
      railLabel: updateRestartingTitle('0.2.0'),
      railAction: null,
      linkLabel: null,
      buttons: [],
    })
  })

  it('offers Restart now once a restart is pending, which re-runs the update', () => {
    expect(downloadViewOf(RELEASE, RESTART_PENDING)).toMatchObject({
      kind: 'restart-pending',
      title: updateRestartPendingTitle('0.2.0'),
      hint: UPDATE_RESTART_PENDING_HINT,
      railAction: 'download',
      linkLabel: UPDATE_NOTES_LABEL,
      buttons: [{ action: 'download', label: UPDATE_RESTART_LABEL, variant: 'default' }],
    })
  })

  it('points a missing asset at the release page, with no Update button', () => {
    expect(downloadViewOf(RELEASE, NO_ASSET)).toMatchObject({
      kind: 'no-asset',
      title: updateNoAssetCopy('0.2.0', NO_ASSET_TARGET),
      railAction: 'open-page',
      linkLabel: UPDATE_OPEN_PAGE_LABEL,
      buttons: [],
    })
    expect(downloadViewOf(RELEASE, { ...NO_ASSET, target: null }).title).toBe(updateNoAssetCopy('0.2.0', null))
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
    expect(toast).toMatchObject({ tone: 'info', title: updateRestartPendingTitle('0.2.0'), description: UPDATE_RESTART_PENDING_HINT })
    expect(toast?.action?.label).toBe(UPDATE_RESTART_LABEL)
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it('reports an opened installer as a success with its hint', () => {
    expect(downloadToastOf(ready('dmg', 'opened'), toastActions())).toMatchObject({ tone: 'success', title: updateDownloadedTitle('0.2.0'), description: UPDATE_READY_HINT.dmg, action: null })
  })

  it('reports a revealed installer as info', () => {
    expect(downloadToastOf(ready('appimage', 'revealed'), toastActions())).toMatchObject({ tone: 'info', description: UPDATE_READY_HINT.appimage })
    expect(downloadToastOf(ready('nsis', 'revealed', 'x'), toastActions())?.description).toBe(UPDATE_OPEN_FAILED_HINT)
  })

  it.each(Object.keys(UPDATE_DOWNLOAD_FAILED_COPY) as UpdateDownloadErrorKind[])('reports a %s failure as an error whose action retries', (reason) => {
    const a = toastActions()
    const toast = downloadToastOf(failed(reason), a)
    expect(toast).toMatchObject({ tone: 'error', title: UPDATE_DOWNLOAD_FAILED_COPY[reason]('0.2.0') })
    expect(toast?.action?.label).toBe(UPDATE_RETRY_LABEL)
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it('reports a missing asset as info whose action opens the release page', () => {
    const a = toastActions()
    const toast = downloadToastOf(NO_ASSET, a)
    expect(toast).toMatchObject({ tone: 'info', title: updateNoAssetCopy('0.2.0', NO_ASSET_TARGET) })
    expect(toast?.action?.label).toBe(UPDATE_OPEN_PAGE_LABEL)
    toast?.action?.onClick()
    expect(a.openPage).toHaveBeenCalledWith('https://example.test/notes')
  })
})
