// The issues list covers issues and pull requests, labels and state included, so its ETag is the cheap "did anything change" signal. The body is never read.
import { conditionalGet, etagKey } from '@/main/github/conditional'
import type { GitHubConditionalContext } from '@/main/github/context'
import { describeHttp } from '@/main/github/envelope'

import type { EtagCache } from '@/types/github'
import type { ConditionalRequest } from '@/types/platform'
import type { GithubPrecheckOutcome } from '@/types/state'
import type { TrackerPrecheckParams } from '@/main/github/tracker/types'

type PrecheckParams = TrackerPrecheckParams & { readonly cache: EtagCache }

export function precheckRequest(repo: PrecheckParams['repo']): Omit<ConditionalRequest, 'ifNoneMatch'> {
  return { method: 'GET', path: `repos/${repo.owner}/${repo.name}/issues?state=all&sort=updated&direction=desc&per_page=1` }
}

/** The first response only primes the cache: with no ETag to compare against, a 200 says nothing changed. */
export async function precheckIssues(ctx: GitHubConditionalContext, params: PrecheckParams): Promise<GithubPrecheckOutcome> {
  const request = precheckRequest(params.repo)
  const primed = params.cache.lookup(params.repoId, etagKey(request)).etag === null
  const result = await conditionalGet(ctx, { cache: params.cache, repoId: params.repoId, request })
  const at = ctx.clock.now().toISOString()
  if (!result.ok) return { ok: false, at, error: describeHttp(result) }
  return { ok: true, at, changed: result.outcome === 'modified' && !primed }
}
