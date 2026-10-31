// The one place that writes the `session:marks` cache — pin/archive set, with Undo (DESIGN §4: reversible actions toast with Undo).
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { invoke } from '@/renderer/data/invoke'
import type { SessionMarkResult, SessionMarks } from '@/types/hosting'
import { markFailureToast, markSuccessToast, UNDO_LABEL } from '@/renderer/session/marks-copy'

export function useSessionMarks() {
  return useIpcQuery('session:marks')
}

type MarkKind = 'pinned' | 'archived'

async function invokeSet(kind: MarkKind, sessionId: string, on: boolean): Promise<SessionMarkResult> {
  return kind === 'pinned' ? invoke('session:pin:set', { sessionId, pinned: on }) : invoke('session:archive:set', { sessionId, archived: on })
}

export async function setSessionMark(queryClient: QueryClient, kind: MarkKind, sessionId: string, on: boolean): Promise<void> {
  try {
    const result = await invokeSet(kind, sessionId, on)
    if (!result.ok) {
      toast(markFailureToast(kind, result))
      return
    }
    queryClient.setQueryData<SessionMarks>(ipcQueryOptions('session:marks').queryKey, result.marks)
    toast(markSuccessToast(kind, on), { action: { label: UNDO_LABEL, onClick: () => void setSessionMark(queryClient, kind, sessionId, !on) } })
  } catch {
    toast(markFailureToast(kind, 'unreachable'))
  }
}
