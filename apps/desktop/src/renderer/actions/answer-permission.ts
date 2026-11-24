import { useState } from 'react'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import type { PermissionDecision } from '@/types/hosting'
import type { QueuedPermission } from '@/types/permission'

export function useAnswerPermission() {
  const mutation = useActionMutation('session.permissionAnswer', { toast: { result: () => null, unreachable: null } })
  const [sending, setSending] = useState<PermissionDecision | null>(null)
  const [failed, setFailed] = useState(false)

  async function answer(item: QueuedPermission, decision: PermissionDecision, message: string): Promise<void> {
    setSending(decision)
    setFailed(false)
    const result = await mutation.perform({
      sessionKey: item.sessionKey,
      permissionId: item.permission.permissionId,
      decision,
      message: decision === 'deny' ? message.trim() || null : null,
    })
    setSending(null)
    setFailed(result === 'unreachable')
  }

  return { answer, sending, failed }
}
