import { describe, expect, it, vi } from 'vitest'
import { checkToastOf, downloadToastOf, downloadViewOf, noticeOf, statusOf } from '@/renderer/update/model'
import { UPDATE_DISABLED_COPY, UPDATE_DOWNLOAD_FAILED_COPY, UPDATE_ERROR_COPY, UPDATE_READY_HINT } from '@/renderer/update/copy'
import type { AvailableRelease, InstallPackage, UpdateDownloadErrorKind, UpdateDownloadState, UpdateErrorKind, UpdateState } from '@/types/update'

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
    expect(a.update).toHaveBeenCalledOnce()
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

const BASE = { version: '0.2.0', notesUrl: 'https://example.test/notes' }
const MB = 1024 * 1024
const IDLE: UpdateDownloadState = { kind: 'idle' }

function ready(pkg: InstallPackage, opened: 'opened' | 'revealed', openError: string | null = null): UpdateDownloadState {
  return { kind: 'ready', ...BASE, assetName: 'port-0.2.0.x', path: '/d/port-0.2.0.x', package: pkg, opened, openError, finishedAt: CHECKED_AT }
}

const downloading = (receivedBytes: number, totalBytes: number): UpdateDownloadState => ({ kind: 'downloading', ...BASE, assetName: 'port-0.2.0.x', receivedBytes, totalBytes, startedAt: CHECKED_AT })
const failed = (reason: UpdateDownloadErrorKind): UpdateDownloadState => ({ kind: 'failed', ...BASE, assetName: 'port-0.2.0.x', reason, detail: 'x', failedAt: CHECKED_AT })
const NO_ASSET: UpdateDownloadState = { kind: 'no-asset', ...BASE, target: { os: 'linux', arch: 'arm64', package: 'deb' } }

describe('downloadViewOf', () => {
  it.each<UpdateDownloadState | undefined>([undefined, IDLE])('is the available prompt for %j', (download) => {
    expect(downloadViewOf(RELEASE, download)).toMatchObject({
      kind: 'idle',
      title: 'port 0.2.0 is available',
      railLabel: 'Update to port 0.2.0',
      railAction: 'download',
      linkLabel: 'Release notes',
      buttons: [{ action: 'download', label: 'Update', variant: 'default' }],
    })
  })

  it('reads a download for another version as idle', () => {
    expect(downloadViewOf(RELEASE, { ...(downloading(10, 100) as object), version: '0.1.5' } as UpdateDownloadState).kind).toBe('idle')
  })

  it('shows progress while downloading, with no buttons and no rail action', () => {
    const view = downloadViewOf(RELEASE, downloading(54 * MB, 120 * MB))
    expect(view).toMatchObject({ kind: 'downloading', title: 'Downloading port 0.2.0', percent: 45, progressText: '54.0 MB of 120.0 MB · 45%', railAction: null, buttons: [], linkLabel: 'Release notes' })
    expect(view.railLabel).toBe('Downloading port 0.2.0 · 45%')
  })

  it('has no percent for an unknown total', () => {
    const view = downloadViewOf(RELEASE, downloading(54 * MB, 0))
    expect(view).toMatchObject({ percent: null, progressText: '54.0 MB', railLabel: 'Downloading port 0.2.0' })
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
      title: 'port 0.2.0 downloaded',
      hint: UPDATE_READY_HINT[pkg],
      railAction: 'open',
      buttons: [
        { action: 'reveal', label: 'Show in folder', variant: 'outline' },
        { action: 'open', label: 'Open installer', variant: 'default' },
      ],
    })
  })

  it('offers only Show in folder for an AppImage, with its own hint', () => {
    expect(downloadViewOf(RELEASE, ready('appimage', 'revealed'))).toMatchObject({
      hint: UPDATE_READY_HINT.appimage,
      railAction: 'reveal',
      buttons: [{ action: 'reveal', label: 'Show in folder', variant: 'default' }],
    })
  })

  it('explains a failed open and offers Show in folder', () => {
    expect(downloadViewOf(RELEASE, ready('dmg', 'revealed', 'no application'))).toMatchObject({
      hint: "port couldn't open the installer, so it's shown in its folder. Open it from there.",
      railAction: 'reveal',
      buttons: [{ action: 'reveal', variant: 'default' }],
    })
  })

  it.each(Object.keys(UPDATE_DOWNLOAD_FAILED_COPY) as UpdateDownloadErrorKind[])('names the %s reason and offers Try again and the release page', (reason) => {
    const text = UPDATE_DOWNLOAD_FAILED_COPY[reason]('0.2.0')
    expect(downloadViewOf(RELEASE, failed(reason))).toMatchObject({
      kind: 'failed',
      title: 'port 0.2.0 is available',
      hint: text,
      railLabel: text,
      railAction: 'download',
      linkLabel: 'Open release page',
      buttons: [{ action: 'download', label: 'Try again', variant: 'default' }],
    })
  })

  it('points a missing asset at the release page, with no Update button', () => {
    expect(downloadViewOf(RELEASE, NO_ASSET)).toMatchObject({
      kind: 'no-asset',
      title: "There's no port 0.2.0 download for Linux .deb (Arm). Get it from the release page.",
      railAction: 'open-page',
      linkLabel: 'Open release page',
      buttons: [],
    })
    expect(downloadViewOf(RELEASE, { ...NO_ASSET, target: null }).title).toContain('this system')
  })
})

describe('downloadToastOf', () => {
  const toastActions = () => ({ retry: vi.fn(), openPage: vi.fn() })

  it.each<UpdateDownloadState>([IDLE, downloading(1, 2)])('shows no toast for $kind', (state) => {
    expect(downloadToastOf(state, toastActions())).toBeNull()
  })

  it('reports an opened installer as a success with its hint', () => {
    expect(downloadToastOf(ready('dmg', 'opened'), toastActions())).toMatchObject({ tone: 'success', title: 'port 0.2.0 downloaded', description: UPDATE_READY_HINT.dmg, action: null })
  })

  it('reports a revealed installer as info', () => {
    expect(downloadToastOf(ready('appimage', 'revealed'), toastActions())).toMatchObject({ tone: 'info', description: UPDATE_READY_HINT.appimage })
    expect(downloadToastOf(ready('nsis', 'revealed', 'x'), toastActions())?.description).toContain("couldn't open the installer")
  })

  it.each(Object.keys(UPDATE_DOWNLOAD_FAILED_COPY) as UpdateDownloadErrorKind[])('reports a %s failure as an error whose action retries', (reason) => {
    const a = toastActions()
    const toast = downloadToastOf(failed(reason), a)
    expect(toast).toMatchObject({ tone: 'error', title: UPDATE_DOWNLOAD_FAILED_COPY[reason]('0.2.0') })
    expect(toast?.action?.label).toBe('Try again')
    toast?.action?.onClick()
    expect(a.retry).toHaveBeenCalledOnce()
  })

  it('reports a missing asset as info whose action opens the release page', () => {
    const a = toastActions()
    const toast = downloadToastOf(NO_ASSET, a)
    expect(toast).toMatchObject({ tone: 'info', title: expect.stringContaining('Linux .deb (Arm)') as string })
    expect(toast?.action?.label).toBe('Open release page')
    toast?.action?.onClick()
    expect(a.openPage).toHaveBeenCalledWith('https://example.test/notes')
  })
})
