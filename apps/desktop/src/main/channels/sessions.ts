import type { ReadSessionStateParams, TranscriptTailStore } from '@/types/sessions'

// `main/ipc.ts` stays the registrar; a channel's validation and composition move here as each is next touched.
import type { RepositoryEntry } from '@/utils/repos'
import type { SessionScan } from '@/types/sessions'
import type { TranscriptTailOpen, TranscriptTailPoll } from '@/utils/sessions/transcript'
import type { SearchResult, SearchScope } from '@/types/search'
import type { IpcMap } from '@/types/ipc'
import { listRepositories } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'
import { readSessionState } from '@/main/sessions/adapter'
import { tailStore } from '@/main/sessions/tail'

import type { LocalRepoRef } from '@/types/github'

import { runSearch } from '@/main/search/query'

import type { SearchQueryDeps } from '@/types/channels'

interface SessionsScanDeps {
  readonly listRepositories: typeof listRepositories
  readonly readSessionState: (params: ReadSessionStateParams) => Promise<SessionScan>
}

export const defaultSessionsScanDeps: SessionsScanDeps = { listRepositories, readSessionState }

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

export async function resolveSessionsScan(registryDeps: RegistryDeps, deps: SessionsScanDeps = defaultSessionsScanDeps): Promise<SessionScan> {
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'sessions:scan' could not list repositories: ${list.message}`)
  const repos: readonly LocalRepoRef[] = list.repositories.filter(isReady).map((entry) => ({ id: entry.id, root: entry.path }))
  return deps.readSessionState({ repos })
}

export interface TranscriptTailDeps {
  readonly openTail: TranscriptTailStore['openTail']
  readonly pollTail: TranscriptTailStore['pollTail']
  readonly closeTail: TranscriptTailStore['closeTail']
}

const defaultTranscriptTailDeps: TranscriptTailDeps = {
  openTail: (params) => tailStore.openTail(params),
  pollTail: (params) => tailStore.pollTail(params),
  closeTail: (params) => tailStore.closeTail(params),
}

export async function resolveTranscriptTailOpen(
  request: IpcMap['transcript:tail:open']['request'],
  deps: TranscriptTailDeps = defaultTranscriptTailDeps,
): Promise<TranscriptTailOpen> {
  if (typeof request?.sessionId !== 'string' || request.sessionId === '') {
    throw new Error("'transcript:tail:open' requires a non-empty 'sessionId'")
  }
  if (request.agentId !== null && typeof request.agentId !== 'string') {
    throw new Error("'transcript:tail:open' requires 'agentId' to be a string or null")
  }
  return deps.openTail({ sessionId: request.sessionId, agentId: request.agentId })
}

export async function resolveTranscriptTailPoll(
  request: IpcMap['transcript:tail:poll']['request'],
  deps: TranscriptTailDeps = defaultTranscriptTailDeps,
): Promise<TranscriptTailPoll> {
  if (typeof request?.tailId !== 'string' || request.tailId === '') {
    throw new Error("'transcript:tail:poll' requires a non-empty 'tailId'")
  }
  return deps.pollTail({ tailId: request.tailId })
}

export function resolveTranscriptTailClose(
  request: IpcMap['transcript:tail:close']['request'],
  deps: TranscriptTailDeps = defaultTranscriptTailDeps,
): void {
  if (typeof request?.tailId !== 'string' || request.tailId === '') {
    throw new Error("'transcript:tail:close' requires a non-empty 'tailId'")
  }
  deps.closeTail({ tailId: request.tailId })
}

const defaultSearchQueryDeps: SearchQueryDeps = { resolveSessionsScan, runSearch }

function isValidScope(scope: unknown): scope is SearchScope {
  if (typeof scope !== 'object' || scope === null) return false
  const value = scope as Record<string, unknown>
  if (value['kind'] === 'all') return true
  return value['kind'] === 'repo' && typeof value['repoId'] === 'string' && value['repoId'] !== ''
}

/** A query that *parses* to zero usable terms is `runSearch`'s own `invalid-query` answer,
 *  a value rather than a thrown error. */
export async function resolveSearchQuery(
  registryDeps: RegistryDeps,
  request: IpcMap['search:query']['request'],
  indexDir: string,
  deps: SearchQueryDeps = defaultSearchQueryDeps,
): Promise<SearchResult> {
  if (typeof request?.query !== 'string' || request.query === '') {
    throw new Error("'search:query' requires a non-empty 'query'")
  }
  if (!isValidScope(request.scope)) {
    throw new Error("'search:query' requires 'scope' to be { kind: 'repo', repoId } or { kind: 'all' }")
  }
  const scan = await deps.resolveSessionsScan(registryDeps)
  return deps.runSearch({ scan, indexDir, query: request.query, scope: request.scope })
}
