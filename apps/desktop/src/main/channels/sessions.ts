// The sessions/transcript/search resolvers — relocated verbatim out of
// `main/ipc.ts` (#92) so that file can register the plan gate's four new
// channels without crossing the 500-line ratchet. `docs/ENGINEERING.md` §1's
// own rule: a channel's validation and composition move here as each is next
// touched; `main/ipc.ts` stays the registrar. No behaviour change in this
// relocation — every function, its own deps interface, and its own default
// wiring are unchanged from what left `main/ipc.ts`.
import type { RepositoryEntry } from '../../shared/repos'
import type { SessionScan } from '../../shared/sessions/types'
import type { TranscriptRead, TranscriptTailOpen, TranscriptTailPoll } from '../../shared/sessions/transcript'
import type { SearchResult, SearchScope } from '../../shared/search/types'
import type { IpcMap } from '../../shared/ipc'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import { openTranscript, readSessionState, tailStore } from '../sessions'
import type { OpenTranscriptParams, OpenTranscriptResult, ReadSessionStateParams, RepoRef, TailStore } from '../sessions'
import { runSearch } from '../search'
import type { RunSearchParams } from '../search'

/** `'sessions:scan'`'s only composition: the ready repository list becomes
 *  `readSessionState`'s `repos`, never a second config or worktree reader —
 *  reconciliation against labels is #79's job, not this channel's. */
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

/** `'transcript:read'`'s only composition (#83, kept behind #84's byte-cursor
 *  primitive): a thin shim over `openTranscript` — open, read once through to
 *  EOF, then discard the cursor, since a one-shot caller never advances it.
 *  Same validation order and return shape #83's now-deleted `readTranscript`
 *  gave this channel; no second parallel line-reading code path lives beside
 *  the tail channels' `TailStore`.
 *
 *  Preserved but currently unused: no renderer code calls `'transcript:read'`
 *  any more — `main.ts`'s `handleOpenTranscript` goes exclusively through
 *  `transcriptTailOpen`. Kept per the rebase's own D1/D2 decision rather than
 *  removed, in case a one-shot caller returns. */
export interface TranscriptReadDeps {
  readonly openTranscript: (params: OpenTranscriptParams) => Promise<OpenTranscriptResult>
}

const defaultTranscriptReadDeps: TranscriptReadDeps = { openTranscript }

export async function resolveTranscriptRead(
  request: IpcMap['transcript:read']['request'],
  deps: TranscriptReadDeps = defaultTranscriptReadDeps,
): Promise<TranscriptRead> {
  if (typeof request?.sessionId !== 'string' || request.sessionId === '') {
    throw new Error("'transcript:read' requires a non-empty 'sessionId'")
  }
  if (request.agentId !== null && typeof request.agentId !== 'string') {
    throw new Error("'transcript:read' requires 'agentId' to be a string or null")
  }
  const { read } = await deps.openTranscript({ sessionId: request.sessionId, agentId: request.agentId })
  return read
}

/** The three tail channels' only composition: each request's own validation,
 *  then a direct call into the one running `TailStore` (`tailStore`) —
 *  injected here so a test exercises the validation branching without a real
 *  transcript on disk, the same seam every other channel's `*Deps` gives. */
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

/** `'search:query'`'s only composition: the same `resolveSessionsScan` every
 *  `'sessions:scan'` request builds becomes `runSearch`'s `scan` -- never a
 *  second scan builder -- so a repository this caller cannot read is the
 *  same `sessions-unavailable` answer either channel would give. */
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

/** A malformed payload throws (a renderer bug, per every other channel's own
 *  rule) -- a query that *parses* to zero usable terms is `runSearch`'s own
 *  `invalid-query` answer, a value rather than a thrown error, since it is
 *  still a well-formed request. */
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
