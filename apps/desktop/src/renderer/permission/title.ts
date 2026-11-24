import type { QueryClient } from '@tanstack/react-query'
import { observeIpcQuery } from '@/renderer/data/query'
import { documentTitle } from '@/renderer/permission/copy'
import { pendingPermissionsOf } from '@/renderer/permission/queue'

export function connectPermissionTitle(client: QueryClient): () => void {
  return observeIpcQuery(client, 'session.list', undefined, (result) => {
    if (result.status === 'success') document.title = documentTitle(pendingPermissionsOf(result.data).waiting)
  })
}
