// Canned `gh api graphql` stdout for the pipeline sweep, shaped like a real two-connection reply.
export const RATE_LIMIT_REPLY = { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z', limit: 5000 }

interface PageInfo {
  readonly hasNextPage: boolean
  readonly endCursor: string | null
}

const LAST_PAGE: PageInfo = { hasNextPage: false, endCursor: null }

export function connection(nodes: readonly unknown[], pageInfo: PageInfo = LAST_PAGE, totalCount: number = nodes.length): unknown {
  return { totalCount, pageInfo, nodes }
}

/** A sweep reply with no items on either surface. */
export const EMPTY_PIPELINE_STDOUT = JSON.stringify({
  data: { repository: { issues: connection([]), pullRequests: connection([]) }, rateLimit: RATE_LIMIT_REPLY },
})
