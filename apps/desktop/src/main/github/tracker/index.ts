// The GitHub implementation of the issue-side `Tracker`: it binds the transport, owns the ETag cache behind `precheck`, and sends the plan body through `main/writes`.
import { createEtagCache } from '@/main/github/conditional'
import { fetchBacklog } from '@/main/github/tracker/backlog'
import { fetchBacklogDetail } from '@/main/github/tracker/backlog-detail'
import { readBoardIssues } from '@/main/github/tracker/board'
import { fetchGatePreflight } from '@/main/github/tracker/gate'
import { readItemStates } from '@/main/github/tracker/item-states'
import { readClaimPreflight, readItemsByNumber } from '@/main/github/tracker/items'
import { readLedger } from '@/main/github/tracker/ledger'
import { precheckIssues } from '@/main/github/tracker/precheck'
import { postIssueBody } from '@/main/writes/apply'
import type { ConditionalTransport, GitHubTransport } from '@/types/platform'
import type { Tracker } from '@/types/tracker'

interface GithubTrackerParams {
  readonly github?: GitHubTransport
  readonly conditional?: ConditionalTransport
  readonly now?: () => Date
}

export function createGithubTracker(params: GithubTrackerParams = {}): Tracker {
  const { github, conditional } = params
  const cache = createEtagCache()

  return {
    readBoardIssues: (request) => readBoardIssues({ ...request, github }),
    precheck: ({ repoId, repo }) => precheckIssues({ cache, repoId, repo, conditional, now: params.now }),
    forget: (repoId) => {
      cache.forget(repoId)
    },
    readItemsByNumber: (request) => readItemsByNumber({ ...request, github, now: request.now ?? params.now }),
    readItemStates: (request) => readItemStates({ ...request, github }),
    readClaimPreflight: (request) => readClaimPreflight({ ...request, github, now: request.now ?? params.now }),
    readGatePreflight: (request) => fetchGatePreflight({ ...request, github, now: request.now ?? params.now }),
    listBacklog: (request) => fetchBacklog({ ...request, github, now: request.now ?? params.now }),
    readTicket: (request) => fetchBacklogDetail({ ...request, github, now: request.now ?? params.now }),
    readLedger: (request) => readLedger({ ...request, github }),
    postPlanBody: (request) => postIssueBody(request),
  }
}
