// The renderer's one TanStack Query composition root (#316) — every screen
// reads IPC data through `useIpcQuery`/`useIpcMutation`, never a bare
// `window.port` call or a `useEffect` fetch.
import { QueryClient, QueryObserver, useMutation, useQuery, queryOptions } from '@tanstack/react-query'
import type { QueryObserverResult } from '@tanstack/react-query'
import type { IpcMap } from '../../../shared/ipc'
import { invoke } from './invoke'
import type { MutationChannel, QueryChannel } from './channels'

/** `networkMode: 'always'` because IPC never touches the network — the
 *  default `'online'` mode would pause every query on an offline machine,
 *  which this app is routinely. `retry: false` (DESIGN §4: nothing retries
 *  on its own). `refetchOnWindowFocus: false` — a window focus is not a
 *  signal that main-process state changed. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { networkMode: 'always', retry: false, refetchOnWindowFocus: false },
      mutations: { networkMode: 'always', retry: false },
    },
  })
}

/** `board:snapshot` gets `staleTime: Infinity` because `data/subscriptions.ts`'s
 *  `connectQueryCache` keeps it fresh from the `board:update` push — a
 *  background refetch here would race that cache write. `backlog:list` gets
 *  a 60s `staleTime` (the Backlog screen's own read) — open issues don't
 *  move fast enough to justify refetching on every remount. `worktrees:report`
 *  also gets `staleTime: Infinity` (#319) — a reclamation report runs only on
 *  an explicit Inspect/Refresh (`worktrees-tab.tsx` passes `enabled: false`
 *  and calls `refetch()` itself), never polled. */
export function ipcQueryOptions<C extends QueryChannel>(channel: C, request?: IpcMap[C]['request']) {
  return queryOptions({
    queryKey: [channel, request ?? null] as const,
    queryFn: () => invoke(channel, request),
    ...(channel === 'board:snapshot' || channel === 'worktrees:report' ? { staleTime: Infinity } : {}),
    ...(channel === 'backlog:list' ? { staleTime: 60_000 } : {}),
  })
}

export function useIpcQuery<C extends QueryChannel>(channel: C, request?: IpcMap[C]['request']) {
  return useQuery(ipcQueryOptions(channel, request))
}

export function useIpcMutation<C extends MutationChannel>(channel: C) {
  return useMutation({
    mutationFn: (request?: IpcMap[C]['request']) => invoke(channel, request),
  })
}

/** Wraps a `QueryObserver` for a legacy (hand-built DOM) consumer that
 *  cannot call a hook — `main.ts`'s `initBoard` is the first one. Returns the
 *  observer's own unsubscribe function. */
export function observeIpcQuery<C extends QueryChannel>(
  client: QueryClient,
  channel: C,
  request: IpcMap[C]['request'] | undefined,
  listener: (result: QueryObserverResult<IpcMap[C]['response']>) => void,
): () => void {
  const observer = new QueryObserver(client, ipcQueryOptions(channel, request))
  return observer.subscribe(listener)
}
