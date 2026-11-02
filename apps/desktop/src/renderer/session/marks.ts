// The one place that writes the `session:marks` cache — pin/archive set, with Undo (DESIGN §4: reversible actions toast with Undo).
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { invoke } from '@/renderer/data/invoke'
import type { SessionKey, SessionMarkResult, SessionMarks } from '@/types/hosting'
import type { ActionToast } from '@/types/toast'
import { close } from '@/renderer/session/actions'
import { UNDO_LABEL } from '@/renderer/lib/copy'
import { FRESH, showActionToast } from '@/renderer/lib/background-action'
import { ARCHIVING_PENDING } from '@/renderer/session/copy'
import { markFailureToast, markSuccessToast } from '@/renderer/session/marks-copy'

export function useSessionMarks() {
  return useIpcQuery('session:marks')
}

type MarkKind = 'pinned' | 'archived'

async function invokeSet(kind: MarkKind, sessionId: string, on: boolean): Promise<SessionMarkResult> {
  return kind === 'pinned' ? invoke('session:pin:set', { sessionId, pinned: on }) : invoke('session:archive:set', { sessionId, archived: on })
}

function failure(title: string): ActionToast {
  return { tone: 'error', title, description: null, action: null, cancel: null }
}

/** `closeKey` is the live session to end alongside an archive; it is ignored for any other mark. */
export async function setSessionMark(queryClient: QueryClient, kind: MarkKind, sessionId: string, on: boolean, closeKey: SessionKey | null = null): Promise<void> {
  const id = `session-mark:${sessionId}`
  const closing = kind === 'archived' && on && closeKey !== null
  if (closing) toast.loading(ARCHIVING_PENDING, { ...FRESH, id, description: undefined })
  try {
    const result = await invokeSet(kind, sessionId, on)
    if (!result.ok) {
      showActionToast(id, failure(markFailureToast(kind, result)))
      return
    }
    queryClient.setQueryData<SessionMarks>(ipcQueryOptions('session:marks').queryKey, result.marks)
    const closed = closing && (await close(closeKey).then(
      (closeResult) => closeResult.ok,
      (error: unknown) => {
        console.error('Failed to close a session after archiving it', error)
        return false
      },
    ))
    showActionToast(id, {
      tone: closing && !closed ? 'info' : 'success',
      title: markSuccessToast(kind, on, closed),
      description: null,
      action: { label: UNDO_LABEL, onClick: () => void setSessionMark(queryClient, kind, sessionId, !on) },
      cancel: null,
    })
  } catch {
    showActionToast(id, failure(markFailureToast(kind, 'unreachable')))
  }
}
