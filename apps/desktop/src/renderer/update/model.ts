// Pure projections of an `UpdateState` into the notice, the About status line and the check toast.
import type { ActionToast } from '@/types/toast'
import type { AvailableRelease, UpdateNoticeView, UpdateState, UpdateStatusView } from '@/types/update'
import { formatAgo } from '@/renderer/lib/relative-time'
import {
  UPDATE_CHECKING,
  UPDATE_DISABLED_COPY,
  UPDATE_ERROR_COPY,
  UPDATE_NOT_CHECKED,
  UPDATE_RETRY_LABEL,
  UPDATE_BUTTON_LABEL,
  UPDATE_UP_TO_DATE,
  updateAvailableTitle,
  updateCurrentDescription,
  updateLatestDescription,
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

interface ToastActions {
  readonly update: (release: AvailableRelease) => void
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
        action: { label: UPDATE_BUTTON_LABEL, onClick: () => actions.update(release) },
        cancel: null,
      }
    }
    case 'error':
      return { tone: 'error', title: UPDATE_ERROR_COPY[state.reason], description: null, action: { label: UPDATE_RETRY_LABEL, onClick: actions.retry }, cancel: null }
  }
}
