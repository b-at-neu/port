// Copy for the one owner state that needs the operator's attention.
import type { RepoDispatchStatus } from '@/types/dispatch'

/** `null` for `app` and `none` — nothing for the operator to act on. */
export function ownershipBannerFor(status: RepoDispatchStatus, repoName: string): string | null {
  if (status.owner !== 'unreadable') return null
  return `${repoName} — .agents/cockpit.json can't be read (${status.unreadableMessage ?? 'unknown reason'}). Neither this app nor a terminal cockpit runs this repo until it's fixed or deleted.`
}
