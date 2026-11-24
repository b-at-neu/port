// Pin and archive writes, each with Undo (DESIGN §4: reversible actions toast with Undo).
import { useIpcQuery } from '@/renderer/data/query'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import type { SessionKey } from '@/types/hosting'
import { useCloseSession } from '@/renderer/session/actions'
import { markToast } from '@/renderer/session/outcomes'
import { markPendingToast } from '@/renderer/session/marks-copy'

export function useSessionMarks() {
  return useIpcQuery('session.marks')
}

export function useSessionMarkActions() {
  const { close } = useCloseSession()

  function undoPin(sessionId: string, pinned: boolean): Promise<unknown> {
    return pin.perform({ sessionId, pinned })
  }

  function undoArchive(sessionId: string, archived: boolean): Promise<unknown> {
    return archive.perform({ sessionId, archived })
  }

  const pin = useActionMutation('session.pinSet', {
    toast: { pending: markPendingToast('pinned'), result: (result, input) => markToast('pinned', input.pinned, result, () => void undoPin(input.sessionId, !input.pinned)) },
    invalidates: ['session.marks'],
  })
  const archive = useActionMutation('session.archiveSet', {
    toast: { pending: markPendingToast('archived'), result: (result, input) => markToast('archived', input.archived, result, () => void undoArchive(input.sessionId, !input.archived)) },
    invalidates: ['session.marks'],
  })

  async function setPinned(sessionId: string, on: boolean): Promise<void> {
    await pin.perform({ sessionId, pinned: on })
  }

  /** `closeKey` is the live session to end alongside an archive; it is ignored when unarchiving. */
  async function setArchived(sessionId: string, on: boolean, closeKey: SessionKey | null): Promise<void> {
    const result = await archive.perform({ sessionId, archived: on })
    if (on && closeKey !== null && result !== 'unreachable' && result.ok) await close(closeKey, { confirm: false })
  }

  return { setPinned, setArchived }
}
