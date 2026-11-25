// The renderer's one TanStack Query composition root (#316) — every screen
// reads IPC data through `useIpcQuery`/`useIpcMutation`, never a bare
// `window.port` call or a `useEffect` fetch.
import { QueryClient, QueryObserver, useMutation, useQuery, queryOptions } from '@tanstack/react-query'
import type { QueryObserverResult } from '@tanstack/react-query'
import type { ActionInput, ActionOutput, MutationName, QueryName } from '@/types/ipc'
import { invoke } from '@/renderer/data/invoke'

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

/** `board.snapshot` gets `staleTime: Infinity` because `data/subscriptions.ts`'s
 *  `connectQueryCache` keeps it fresh from the `board.update` push — a
 *  background refetch here would race that cache write. `backlog.list` gets
 *  a 60s `staleTime` (the Backlog screen's own read) — open issues don't
 *  move fast enough to justify refetching on every remount; `release.status`
 *  shares it for the same reason. `worktrees.report`
 *  also gets `staleTime: Infinity` — a reclamation report runs only on
 *  an explicit Inspect/Refresh (`worktrees-tab.tsx` passes `enabled: false`
 *  and calls `refetch()` itself), never polled. `release.issues` is
 *  `Infinity` too (a tag range never changes), as is `backlog.detail`: Refresh updates it. */
export function ipcQueryOptions<C extends QueryName>(channel: C, request?: ActionInput<C>, extraKey?: readonly unknown[]) {
  return queryOptions({
    queryKey: [channel, request ?? null, ...(extraKey ?? [])] as const,
    queryFn: () => invoke(channel, request),
    ...(channel === 'board.snapshot' || channel === 'worktrees.report' || channel === 'release.issues' || channel === 'backlog.detail' ? { staleTime: Infinity } : {}),
    ...(channel === 'backlog.detail' ? { gcTime: Infinity } : {}),
    ...(channel === 'backlog.list' || channel === 'release.status' ? { staleTime: 60_000 } : {}),
    ...(channel === 'storage.report' ? { staleTime: 5 * 60_000 } : {}),
  })
}

interface IpcQueryOptions<C extends QueryName> {
  readonly enabled?: boolean
  readonly refetchInterval?: number | ((data: ActionOutput<C> | undefined) => number | false)
}

/** Adapts a data-reading interval to TanStack's query-reading one. */
export function queryInterval<D>(interval: number | ((data: D | undefined) => number | false) | undefined): number | ((query: { readonly state: { readonly data: D | undefined } }) => number | false) | undefined {
  return typeof interval === 'function' ? (query) => interval(query.state.data) : interval
}

export function useIpcQuery<C extends QueryName>(channel: C, request?: ActionInput<C>, options?: IpcQueryOptions<C>) {
  return useQuery({ ...ipcQueryOptions(channel, request), enabled: options?.enabled, refetchInterval: queryInterval(options?.refetchInterval) })
}

export function useIpcMutation<C extends MutationName>(channel: C) {
  return useMutation({
    mutationFn: (request?: ActionInput<C>) => invoke(channel, request),
  })
}

/** Wraps a `QueryObserver` for a legacy (hand-built DOM) consumer that
 *  cannot call a hook — `main.ts`'s `initBoard` is the first one. Returns the
 *  observer's own unsubscribe function. */
export function observeIpcQuery<C extends QueryName>(
  client: QueryClient,
  channel: C,
  request: ActionInput<C> | undefined,
  listener: (result: QueryObserverResult<ActionOutput<C>>) => void,
): () => void {
  const observer = new QueryObserver(client, ipcQueryOptions(channel, request))
  return observer.subscribe(listener)
}
