import { useRouterState } from '@tanstack/react-router'
import { ROUTE_IDS } from '@/renderer/app/routes'
import type { SessionKey } from '@/types/hosting'

interface RouteLocation {
  readonly pathname: string
  readonly search: unknown
}

/** The session on screen: the Session route's `key` search param, else none. */
export function sessionKeyOf(location: RouteLocation): SessionKey | null {
  if (location.pathname !== ROUTE_IDS.session) return null
  const { key } = location.search as { readonly key?: unknown }
  return typeof key === 'string' && key !== '' ? (key as SessionKey) : null
}

export function useSelectedSessionKey(): SessionKey | null {
  return useRouterState({ select: (state) => sessionKeyOf(state.location) })
}
