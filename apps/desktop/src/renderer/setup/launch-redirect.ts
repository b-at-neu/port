// The launch gate — three cheap reads through the query client, reusing
// `setupModel`. A rejected fetch leaves the restored screen in place.
import type { QueryClient } from '@tanstack/react-query'
import { ipcQueryOptions } from '../data/query'
import { setupModel } from './model'

export async function shouldRedirectToSetup(queryClient: QueryClient): Promise<boolean> {
  try {
    const [preflight, gh, repos] = await Promise.all([
      queryClient.fetchQuery(ipcQueryOptions('runtime:preflight')),
      queryClient.fetchQuery(ipcQueryOptions('gh:status')),
      queryClient.fetchQuery(ipcQueryOptions('repos:list')),
    ])
    const model = setupModel({ status: 'success', data: preflight }, null, { status: 'success', data: gh }, { status: 'success', data: repos })
    return !model.complete
  } catch (error) {
    console.error('[setup] launch redirect check failed', error)
    return false
  }
}
