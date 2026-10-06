// The launch gate (#337) — moved out of `main.ts` to keep that file under
// its own 500-line limit (ENGINEERING §7). Three cheap reads through the
// query client, so the Set up port screen reuses the same cache rather than
// refetching. Never runs a probe turn; `preflight.diagnosis: 'unverified'`
// alone already counts as `done` in `setupModel`. A rejected fetch leaves
// the restored screen in place and logs rather than redirecting on bad data
// — the screen's own `ErrorBanner` covers the failure once it loads.
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
