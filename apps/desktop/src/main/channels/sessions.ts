// `main/ipc.ts` stays the registrar; a channel's validation and composition move here as each is next touched.
import type { RepositoryEntry } from '../../shared/repos'
import type { SessionScan } from '../../shared/sessions/types'
import type { TranscriptTailOpen, TranscriptTailPoll } from '../../shared/sessions/transcript'
import type { SearchResult, SearchScope } from '../../shared/search/types'
import type { IpcMap } from '../../shared/ipc'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import { readSessionState } from '../sessions/adapter'
import { tailStore } from '../sessions/tail'
import type { ReadSessionStateParams } from '../sessions/adapter'
import type { RepoRef } from '../sessions/classify'
import type { TailStore } from '../sessions/tail'
import { runSearch } from '../search/query'
import type { RunSearchParams } from '../search/query'

export interface SessionsScanDeps {
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
  const repos: readonly RepoRef[] = list.repositories.filter(isReady).map((entry) => ({ id: entry.id, root: entry.path }))
  return deps.readSessionState({ repos })
}

export interface TranscriptTailDeps {
  readonly openTail: TailStore['openTail']
  readonly pollTail: TailStore['pollTail']
  readonly closeTail: TailStore['closeTail']
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

export interface SearchQueryDeps {
  readonly resolveSessionsScan: (registryDeps: RegistryDeps) => Promise<SessionScan>
  readonly runSearch: (params: RunSearchParams) => Promise<SearchResult>
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
