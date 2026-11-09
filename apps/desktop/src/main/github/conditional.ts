// A 304 on an authenticated REST call costs nothing against GitHub's `core` bucket. Only the ETag is cached, never the body — callers need "changed or not".
import { DEFAULT_ACCEPT, githubConditional } from '@/main/platform/github-http'

import type { ConditionalGetResult, EtagCache } from '@/types/github'
import type { ConditionalRequest, ConditionalTransport } from '@/types/platform'
import type { RepoId } from '@/utils/repos'

interface RepoEtags {
  generation: number
  readonly entries: Map<string, string>
}

export function createEtagCache(): EtagCache {
  const repos = new Map<RepoId, RepoEtags>()

  function repoOf(repoId: RepoId): RepoEtags {
    const existing = repos.get(repoId)
    if (existing !== undefined) return existing
    const created: RepoEtags = { generation: 0, entries: new Map() }
    repos.set(repoId, created)
    return created
  }

  return {
    lookup: (repoId, key) => {
      const repo = repoOf(repoId)
      return { etag: repo.entries.get(key) ?? null, generation: repo.generation }
    },
    store: (repoId, key, etag, generation) => {
      const repo = repoOf(repoId)
      if (repo.generation !== generation) return
      if (etag === null) repo.entries.delete(key)
      else repo.entries.set(key, etag)
    },
    // The record stays so its bumped generation outlives the delete and a pending `store` is still dropped.
    forget: (repoId) => {
      const repo = repoOf(repoId)
      repo.entries.clear()
      repo.generation += 1
    },
  }
}

/** An ETag is only valid for the exact request shape it was issued for: method, path with its query, and the effective `Accept`. */
export function etagKey(request: Omit<ConditionalRequest, 'ifNoneMatch'>): string {
  return `${request.method} ${request.path} ${request.accept ?? DEFAULT_ACCEPT}`
}

interface ConditionalGetParams {
  readonly cache: EtagCache
  readonly repoId: RepoId
  readonly request: Omit<ConditionalRequest, 'ifNoneMatch'>
  readonly conditional?: ConditionalTransport
}

export async function conditionalGet(params: ConditionalGetParams): Promise<ConditionalGetResult> {
  const { cache, repoId, request } = params
  const send = params.conditional ?? githubConditional
  const key = etagKey(request)
  const known = cache.lookup(repoId, key)

  const result = await send(known.etag === null ? request : { ...request, ifNoneMatch: known.etag })
  if (!result.ok) return result

  const etag = result.headers.etag ?? null
  if (result.notModified) {
    if (etag !== null) cache.store(repoId, key, etag, known.generation)
    // A 304 only answers a sent validator, so `known.etag` is set; GitHub may restate it or issue a fresh one.
    return { ok: true, outcome: 'not-modified', headers: result.headers, etag: etag ?? known.etag ?? '' }
  }
  cache.store(repoId, key, etag, known.generation)
  return { ok: true, outcome: 'modified', status: result.status, headers: result.headers, body: result.body, etag }
}
