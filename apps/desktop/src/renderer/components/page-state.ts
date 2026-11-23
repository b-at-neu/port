export type PageStateKind = 'loading' | 'error' | 'empty' | 'ready'

interface QueryLike<D> {
  readonly data: D | undefined
  readonly status: 'pending' | 'error' | 'success'
}

/** Data in hand beats a later refetch error, so stale data stays on screen; `error` means there is nothing to show. */
export function pageState<D>(query: QueryLike<D>, isEmpty: (data: D) => boolean): PageStateKind {
  if (query.data !== undefined) return isEmpty(query.data) ? 'empty' : 'ready'
  return query.status === 'error' ? 'error' : 'loading'
}
