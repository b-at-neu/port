import type { SessionPhase } from '@/types/hosting'

/** A stage session still holding its item: neither ended nor closing. */
export function isLiveStageSession(session: { readonly phase: SessionPhase }): boolean {
  return session.phase !== 'ended' && session.phase !== 'closing'
}
