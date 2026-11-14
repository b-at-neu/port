// Pure projections of an `UpdateState` into the notice, the About status line and the check toast.
import type { ActionToast } from '@/types/toast'
import type { AvailableRelease, UpdateDownloadButton, UpdateDownloadState, UpdateDownloadView, UpdateNoticeView, UpdateState, UpdateStatusView } from '@/types/update'
import { formatAgo } from '@/renderer/lib/relative-time'
import { formatBytes } from '@/renderer/settings/usage-model'
import {
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
  UPDATE_RETRY_LABEL,
  UPDATE_REVEAL_LABEL,
  UPDATE_BUTTON_LABEL,
  UPDATE_UP_TO_DATE,
  updateAvailableTitle,
  updateCurrentDescription,
  updateDownloadedTitle,
  updateDownloadingRailLabel,
  updateDownloadingTitle,
  updateLatestDescription,
  updateNoAssetCopy,
  updateRailLabel,
} from '@/renderer/update/copy'

export function noticeOf(state: UpdateState | undefined): UpdateNoticeView | null {
  if (state?.kind !== 'available') return null
  return { version: state.release.version, notesUrl: state.release.notesUrl, release: state.release }
}

export function statusOf(state: UpdateState, now: number): UpdateStatusView {
  switch (state.kind) {
    case 'disabled':
      return { kind: state.kind, text: UPDATE_DISABLED_COPY[state.reason], checkedAgo: null, release: null, canCheck: false }
    case 'idle':
      return { kind: state.kind, text: UPDATE_NOT_CHECKED, checkedAgo: null, release: null, canCheck: true }
    case 'checking':
      return { kind: state.kind, text: UPDATE_CHECKING, checkedAgo: null, release: null, canCheck: false }
    case 'up-to-date':
      return { kind: state.kind, text: UPDATE_UP_TO_DATE, checkedAgo: formatAgo(now - Date.parse(state.checkedAt)), release: null, canCheck: true }
    case 'available':
      return { kind: state.kind, text: updateAvailableTitle(state.release.version), checkedAgo: null, release: state.release, canCheck: true }
    case 'error':
      return { kind: state.kind, text: UPDATE_ERROR_COPY[state.reason], checkedAgo: null, release: null, canCheck: true }
  }
}

type Ready = Extract<UpdateDownloadState, { kind: 'ready' }>

function readyHint(state: Ready): string {
  if (state.package === 'appimage' || state.opened === 'opened') return UPDATE_READY_HINT[state.package]
  return UPDATE_OPEN_FAILED_HINT
}

function percentOf(received: number, total: number): number | null {
  if (total <= 0) return null
  return Math.min(100, Math.max(0, Math.floor((received / total) * 100)))
}

function idleView(release: AvailableRelease): UpdateDownloadView {
  return {
    kind: 'idle',
    title: updateAvailableTitle(release.version),
    hint: null,
    percent: null,
    progressText: null,
    railLabel: updateRailLabel(release.version),
    railAction: 'download',
    buttons: [{ action: 'download', label: UPDATE_BUTTON_LABEL, variant: 'default' }],
    linkLabel: UPDATE_NOTES_LABEL,
  }
}

/** A download for another version reads as idle, so a newer release found by a re-check starts fresh. */
export function downloadViewOf(release: AvailableRelease, download: UpdateDownloadState | undefined): UpdateDownloadView {
  if (download === undefined || download.kind === 'idle' || download.version !== release.version) return idleView(release)
  switch (download.kind) {
    case 'downloading': {
      const percent = percentOf(download.receivedBytes, download.totalBytes)
      const received = formatBytes(download.receivedBytes)
      const progress = download.totalBytes > 0 ? `${received} of ${formatBytes(download.totalBytes)}` : received
      return {
        kind: 'downloading',
        title: updateDownloadingTitle(release.version),
        hint: null,
        percent,
        progressText: percent === null ? progress : `${progress} · ${percent}%`,
        railLabel: updateDownloadingRailLabel(release.version, percent),
        railAction: null,
        buttons: [],
        linkLabel: UPDATE_NOTES_LABEL,
      }
    }
    case 'ready': {
      const revealed = download.opened === 'revealed'
      const reveal: UpdateDownloadButton = { action: 'reveal', label: UPDATE_REVEAL_LABEL, variant: revealed ? 'default' : 'outline' }
      return {
        kind: 'ready',
        title: updateDownloadedTitle(release.version),
        hint: readyHint(download),
        percent: null,
        progressText: null,
        railLabel: updateDownloadedTitle(release.version),
        railAction: revealed ? 'reveal' : 'open',
        buttons: revealed ? [reveal] : [reveal, { action: 'open', label: UPDATE_OPEN_LABEL, variant: 'default' }],
        linkLabel: null,
      }
    }
    case 'failed': {
      const reason = UPDATE_DOWNLOAD_FAILED_COPY[download.reason](release.version)
      return {
        kind: 'failed',
        title: updateAvailableTitle(release.version),
        hint: reason,
        percent: null,
        progressText: null,
        railLabel: reason,
        railAction: 'download',
        buttons: [{ action: 'download', label: UPDATE_RETRY_LABEL, variant: 'default' }],
        linkLabel: UPDATE_OPEN_PAGE_LABEL,
      }
    }
    case 'no-asset': {
      const text = updateNoAssetCopy(release.version, download.target)
      return { kind: 'no-asset', title: text, hint: null, percent: null, progressText: null, railLabel: text, railAction: 'open-page', buttons: [], linkLabel: UPDATE_OPEN_PAGE_LABEL }
    }
  }
}

interface DownloadToastActions {
  readonly retry: () => void
  readonly openPage: (url: string) => void
}

/** `null` for `idle`/`downloading`, which a finished download never resolves with. */
export function downloadToastOf(state: UpdateDownloadState, actions: DownloadToastActions): ActionToast | null {
  switch (state.kind) {
    case 'idle':
    case 'downloading':
      return null
    case 'ready':
      return { tone: state.opened === 'opened' ? 'success' : 'info', title: updateDownloadedTitle(state.version), description: readyHint(state), action: null, cancel: null }
    case 'failed':
      return { tone: 'error', title: UPDATE_DOWNLOAD_FAILED_COPY[state.reason](state.version), description: null, action: { label: UPDATE_RETRY_LABEL, onClick: actions.retry }, cancel: null }
    case 'no-asset':
      return { tone: 'info', title: updateNoAssetCopy(state.version, state.target), description: null, action: { label: UPDATE_OPEN_PAGE_LABEL, onClick: () => actions.openPage(state.notesUrl) }, cancel: null }
  }
}

interface ToastActions {
  readonly update: () => void
  readonly retry: () => void
}

/** `null` for `idle`/`checking`, which a check never resolves with. */
export function checkToastOf(state: UpdateState, actions: ToastActions): ActionToast | null {
  switch (state.kind) {
    case 'idle':
    case 'checking':
      return null
    case 'disabled':
      return { tone: 'info', title: UPDATE_DISABLED_COPY[state.reason], description: null, action: null, cancel: null }
    case 'up-to-date':
      return { tone: 'success', title: UPDATE_UP_TO_DATE, description: updateLatestDescription(state.current), action: null, cancel: null }
    case 'available': {
      const { release } = state
      return {
        tone: 'info',
        title: updateAvailableTitle(release.version),
        description: updateCurrentDescription(state.current),
        action: { label: UPDATE_BUTTON_LABEL, onClick: actions.update },
        cancel: null,
      }
    }
    case 'error':
      return { tone: 'error', title: UPDATE_ERROR_COPY[state.reason], description: null, action: { label: UPDATE_RETRY_LABEL, onClick: actions.retry }, cancel: null }
  }
}
