// Navigation for code outside React components. The router imports every screen, so a screen-side module cannot import the router back; it is bound here once instead.
import type { router as appRouter } from '@/renderer/app/router'
import { ROUTE_IDS } from '@/renderer/app/routes'

let bound: typeof appRouter | null = null

export function bindRouter(router: typeof appRouter): void {
  bound = router
}

export function openSession(key: string): void {
  if (bound === null) throw new Error('openSession called before the router was bound')
  void bound.navigate({ to: ROUTE_IDS.session, search: { key } })
}
