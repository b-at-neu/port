import type { Tracker } from '@/types/tracker'
import { createEtagCache } from '@/main/github/conditional'
import type { GitHubTrackerContext } from '@/main/github/context'
import { postIssueBody } from '@/main/github/writes/apply'
import { fetchBacklog } from '@/main/github/tracker/backlog'
import { fetchBacklogDetail } from '@/main/github/tracker/backlog-detail'
import { fetchGatePreflight } from '@/main/github/tracker/gate'
import { fetchClaimPreflight, fetchItemsByNumber } from '@/main/github/tracker/items'
import { readItemStates } from '@/main/github/tracker/item-states'
import { readLedger } from '@/main/github/tracker/ledger'
import { precheckIssues } from '@/main/github/tracker/precheck'

/** Binds the GitHub context slices once and owns the ETag cache the issues-list pre-check compares against. */
export function createGithubTracker(ctx: GitHubTrackerContext): Tracker {
  const cache = createEtagCache()
  return {
    readItemsByNumber: (params) => fetchItemsByNumber(ctx, params),
    readItemStates: (params) => readItemStates(ctx, params),
    readClaimPreflight: (params) => fetchClaimPreflight(ctx, params),
    readGatePreflight: (params) => fetchGatePreflight(ctx, params),
    listBacklog: (params) => fetchBacklog(ctx, params),
    readTicket: (params) => fetchBacklogDetail(ctx, params),
    readLedger: (params) => readLedger(ctx, params),
    precheck: (params) => precheckIssues(ctx, { cache, ...params }),
    forget: (repoId) => {
      cache.forget(repoId)
    },
    postPlanBody: (params) => postIssueBody(ctx, params),
  }
}
