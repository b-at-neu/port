import type { SessionMarks } from '@/types/hosting'
import type { SessionMarkItem } from '@/types/session'
import { menuItemLabel, RENAME_LABEL } from '@/renderer/session/marks-copy'

export function sessionMarkItems({ sessionId, marks, canRename }: { readonly sessionId: string | null; readonly marks: SessionMarks | undefined; readonly canRename: boolean }): readonly SessionMarkItem[] {
  const pinned = sessionId !== null && (marks?.pinned.includes(sessionId) ?? false)
  const archived = sessionId !== null && (marks?.archived.includes(sessionId) ?? false)
  const items: SessionMarkItem[] = []
  if (canRename) items.push({ key: 'rename', label: RENAME_LABEL, disabled: false })
  items.push({ key: 'pin', label: menuItemLabel('pinned', pinned), disabled: sessionId === null })
  items.push({ key: 'archive', label: menuItemLabel('archived', archived), disabled: sessionId === null })
  return items
}
