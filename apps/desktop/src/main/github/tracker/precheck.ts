// The issues list covers issues and pull requests, labels and state included, so its ETag is the cheap "did anything change" signal. The body is never read.
import { conditionalGet, etagKey } from '@/main/github/conditional'
import { describeHttp } from '@/main/github/envelope'

import type { EtagCache } from '@/types/github'
import type { ConditionalRequest, ConditionalTransport } from '@/types/platform'
import type { GithubPrecheckOutcome } from '@/types/state'
import type { RepoId } from '@/utils/repos'

interface PrecheckParams {
  readonly cache: EtagCache
  readonly repoId: RepoId
  readonly repo: { readonly owner: string; readonly name: string }
  readonly conditional?: ConditionalTransport
  readonly now?: () => Date
}

export function precheckRequest(repo: PrecheckParams['repo']): Omit<ConditionalRequest, 'ifNoneMatch'> {
  return { method: 'GET', path: `repos/${repo.owner}/${repo.name}/issues?state=all&sort=updated&direction=desc&per_page=1` }
}

/** The first response only primes the cache: with no ETag to compare against, a 200 says nothing changed. */
export async function precheckIssues(params: PrecheckParams): Promise<GithubPrecheckOutcome> {
  const now = params.now ?? (() => new Date())
  const request = precheckRequest(params.repo)
  const primed = params.cache.lookup(params.repoId, etagKey(request)).etag === null
  const result = await conditionalGet({ cache: params.cache, repoId: params.repoId, request, conditional: params.conditional })
  const at = now().toISOString()
  if (!result.ok) return { ok: false, at, error: describeHttp(result) }
  return { ok: true, at, changed: result.outcome === 'modified' && !primed }
}
