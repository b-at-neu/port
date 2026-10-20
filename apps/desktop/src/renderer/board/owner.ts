// The Board's ownership banners — pure copy for the two owners that need the
// operator's attention. `banners.tsx` renders them and routes Take over to
// `board/dispatch.ts`'s `takeOver`.
import type { RepoDispatchStatus } from '@/types/dispatch'

interface OwnershipBanner {
  readonly kind: 'error' | 'notice'
  readonly message: string
  readonly takeOver: boolean
}

/** `null` for `app` and `none` — nothing for the operator to act on. */
export function ownershipBannerFor(status: RepoDispatchStatus, repoName: string): OwnershipBanner | null {
  switch (status.owner) {
    case 'unreadable':
      return {
        kind: 'error',
        message: `${repoName} — .agents/cockpit.json can't be read (${status.unreadableMessage ?? 'unknown reason'}). Neither this app nor a terminal cockpit runs this repo until it's fixed or deleted.`,
        takeOver: false,
      }
    case 'terminal':
      return { kind: 'notice', message: `Your terminal cockpit runs ${repoName}. This app won't dispatch, answer gates, or write labels there.`, takeOver: true }
    case 'app':
    case 'none':
      return null
  }
}
