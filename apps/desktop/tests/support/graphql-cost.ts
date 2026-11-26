// Records every GraphQL document a transport sends, so a live test can ask GitHub what the same
// documents would cost with `rateLimit(dryRun: true)` rather than trusting the summed real costs.
import type { GitHubRequest, GitHubTransport } from '@/types/platform'

const RATE_LIMIT_SELECTION = 'rateLimit { cost remaining resetAt limit }'

interface DryRunRecorder {
  readonly transport: GitHubTransport
  /** Re-sends each recorded document as a dry run and sums the costs it reports. */
  readonly total: () => Promise<number>
}

function bodyOf(request: GitHubRequest): { readonly query: string; readonly variables: unknown } {
  return JSON.parse(request.body ?? '{}') as { readonly query: string; readonly variables: unknown }
}

export function dryRunCostRecorder(transport: GitHubTransport): DryRunRecorder {
  const recorded: GitHubRequest[] = []
  const recording: GitHubTransport = (request) => {
    recorded.push(request)
    return transport(request)
  }

  const total = async (): Promise<number> => {
    let sum = 0
    for (const request of recorded) {
      const { query, variables } = bodyOf(request)
      const dry = { ...request, body: JSON.stringify({ query: query.replace(RATE_LIMIT_SELECTION, 'rateLimit(dryRun: true) { cost }'), variables }) }
      const result = await transport(dry)
      if (!result.ok) throw new Error(`dry-run read failed: ${result.kind}`)
      const parsed = JSON.parse(result.body) as { readonly data?: { readonly rateLimit?: { readonly cost?: number } } }
      sum += parsed.data?.rateLimit?.cost ?? 0
    }
    return sum
  }

  return { transport: recording, total }
}
