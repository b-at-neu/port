// The one place that writes the `session:marks` cache — pin/archive set, with Undo (DESIGN §4: reversible actions toast with Undo).
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { invoke } from '@/renderer/data/invoke'
import type { SessionKey, SessionMarkResult, SessionMarks } from '@/types/hosting'
import { close } from '@/renderer/session/actions'
import { UNDO_LABEL } from '@/renderer/lib/copy'
import { markFailureToast, markSuccessToast } from '@/renderer/session/marks-copy'

export function useSessionMarks() {
  return useIpcQuery('session:marks')
}

type MarkKind = 'pinned' | 'archived'

async function invokeSet(kind: MarkKind, sessionId: string, on: boolean): Promise<SessionMarkResult> {
  return kind === 'pinned' ? invoke('session:pin:set', { sessionId, pinned: on }) : invoke('session:archive:set', { sessionId, archived: on })
}

/** `closeKey` is the live session to end alongside an archive; it is ignored for any other mark. */
export async function setSessionMark(queryClient: QueryClient, kind: MarkKind, sessionId: string, on: boolean, closeKey: SessionKey | null = null): Promise<void> {
  try {
    const result = await invokeSet(kind, sessionId, on)
    if (!result.ok) {
      toast(markFailureToast(kind, result))
      return
    }
    queryClient.setQueryData<SessionMarks>(ipcQueryOptions('session:marks').queryKey, result.marks)
    const closing = kind === 'archived' && on && closeKey !== null
    if (closing) await close(closeKey)
    toast(markSuccessToast(kind, on, closing), { action: { label: UNDO_LABEL, onClick: () => void setSessionMark(queryClient, kind, sessionId, !on) } })
  } catch {
    toast(markFailureToast(kind, 'unreachable'))
  }
}
