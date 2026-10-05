// Fixture mode's own canned IPC handlers (#317) — one per `IpcChannel`, so
// the exhaustive `FixtureHandlers` type fails `pnpm typecheck` the moment a
// new channel ships with no fixture. Builders take `now: Date`; every
// timestamp a handler returns is `now` minus a fixed offset, so "5m ago"
// renders the same on every run. Fixture requests are not validated — a
// canned answer has nothing to protect — and no handler throws, because a
// rejected invoke renders as an `ErrorBanner` and would misrepresent the
// screen. A write never causes a side effect: each returns its type's own
// "nothing happened" variant where one exists, and otherwise the minimal ok.
import type { IpcChannel, IpcMap } from '../../shared/ipc'
import type { RepoId } from '../../shared/repos'
import type { RepoDispatchStatus, RepoRunState } from '../../shared/dispatch/types'
import { RUN_TARGET } from '../../shared/dispatch/types'
import type { TranscriptSource } from '../../shared/sessions/transcript'
import { fixtureBoardSnapshot } from './board'
import { FIXTURE_REPOSITORIES } from './repos'

/** Exhaustive by construction: a new `IpcChannel` fails `pnpm typecheck` in
 *  `fixtureHandlers`'s own return literal until a fixture exists for it. */
export type FixtureHandlers = { readonly [C in IpcChannel]: (request: IpcMap[C]['request']) => IpcMap[C]['response'] }

const EMPTY_CLAIM = (now: Date): IpcMap['gate:claim:read']['response'] => ({ state: 'absent', path: '/home/you/src/widgets/.agents/gate-claim.json', readAt: now.toISOString() })

function transcriptSourceFor(sessionId: string, agentId: string | null, now: Date): TranscriptSource {
  return { sessionId, agentId, path: '', sizeBytes: 0, modifiedAt: now.toISOString(), recordCount: 0, malformedLines: 0 }
}

function idleDispatchStatus(repoId: RepoId): RepoDispatchStatus {
  return { repoId, owner: 'cockpit', state: { kind: 'idle' }, runState: 'dispatching', claudeSessionId: null, claimedAt: null, budget: null, observed: [] }
}

export function fixtureHandlers(now: Date): FixtureHandlers {
  return {
    // --- Screen reads, populated -------------------------------------------
    'app:info': () => ({ app: '0.1.0', electron: '38.2.1', node: '22.14.0', chromium: '140.0.0.0' }),

    'repos:list': () => ({ ok: true, repositories: FIXTURE_REPOSITORIES }),

    'board:snapshot': () => fixtureBoardSnapshot(now),
    'board:refresh': () => fixtureBoardSnapshot(now),

    'runtime:preflight': () => ({
      checkedAt: now.toISOString(),
      executable: { path: '/usr/local/bin/claude' },
      version: { raw: '2.1.3', belowMinimum: false },
      credentials: { present: true, expiresAt: null, hasRefreshToken: true },
      apiKeyInEnvironment: false,
      diagnosis: 'unverified',
      detail: null,
    }),

    'sessions:scan': () => ({ ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 1, scannedAt: now.toISOString() }),

    'session:list': () => [],
    'session:capacity': () => ({ limit: 4, ceiling: 8 }),
    'session:capacity:set': () => ({ limit: 4, ceiling: 8 }),
    'session:restore:list': () => ({ entries: [] }),

    // --- Click-only reads, valid and empty-but-ok --------------------------
    'worktrees:report': () => ({
      ok: true,
      mainRoot: '/home/you/src/widgets',
      integrationRef: 'dev',
      worktrees: [],
      orphanDirs: [],
      registered: 0,
      byState: {},
      githubResolution: 'resolved',
      porcelainJoin: 'joined',
      readAt: now.toISOString(),
    }),

    'transcript:read': (request) => ({ ok: true, source: transcriptSourceFor(request.sessionId, request.agentId, now), entries: [] }),
    'transcript:tail:open': (request) => ({ ok: true, tailId: 'fixture-tail', source: transcriptSourceFor(request.sessionId, request.agentId, now), entries: [] }),
    'transcript:tail:poll': () => ({ ok: true, source: transcriptSourceFor('fixture-session', null, now), appended: [], patched: [], hasMore: false }),
    'transcript:tail:close': () => undefined,

    'search:query': () => ({ ok: true, groups: [], inScope: 0, skippedByIndex: 0, read: 0, unreached: 0, complete: true, hitsTruncated: false, indexPersisted: false, tookMs: 0 }),

    'claim:preflight': () => ({ kind: 'unresolved' }),
    'gate:preflight': () => ({ kind: 'unresolved', claim: EMPTY_CLAIM(now) }),
    'gate:claim:read': () => EMPTY_CLAIM(now),

    'runtime:probe': () => ({ checkedAt: now.toISOString(), repo: 'acme/widgets', elapsedMs: 420, apiKeyInEnvironment: false, diagnosis: 'verified', detail: null }),

    // --- Writes, never a side effect ---------------------------------------
    'repos:add': () => ({ ok: true, outcome: 'cancelled' }),
    'repos:remove': () => ({ ok: true, repositories: FIXTURE_REPOSITORIES }),

    'item:action': () => ({ ok: true, outcome: { kind: 'no-op' } }),

    'dispatch:control': (request) => {
      if (request.command === 'halt') return { ok: true, command: 'halt', report: { kind: 'completed', items: [] } }
      const runState: RepoRunState = { repoId: request.repoId, state: RUN_TARGET[request.command], since: now.toISOString() }
      if (request.command === 'run') return { ok: true, command: 'run', repoId: request.repoId, runState }
      if (request.command === 'drain') return { ok: true, command: 'drain', repoId: request.repoId, runState, persisted: false }
      return { ok: true, command: 'pause', repoId: request.repoId, runState, report: { kind: 'completed', items: [] } }
    },
    'dispatch:claim:set': (request) => ({ kind: 'ok', status: idleDispatchStatus(request.repoId) }),
    'dispatch:relay': () => ({ ok: false, kind: 'no-dispatcher' }),

    'claim:apply': () => ({ kind: 'refused', verdict: { kind: 'not-found' } }),

    'gate:claim:set': () => ({ kind: 'ok', claim: EMPTY_CLAIM(now) }),
    'gate:answer': () => ({ kind: 'refused', verdict: { kind: 'not-found' } }),

    // `copyRelayReply` would otherwise touch electron's clipboard — fixture
    // mode reports success without ever calling it.
    'relay:copy': () => ({ ok: true }),

    'session:start': () => ({ ok: false, kind: 'runtime', diagnosis: 'unverified', detail: 'Fixture mode: sessions are not started.' }),
    'session:send': () => ({ ok: false, kind: 'unknown-session' }),
    'session:interrupt': () => ({ ok: false, kind: 'unknown-session' }),
    'session:close': () => ({ ok: false, kind: 'unknown-session' }),
    'session:attach': () => ({ ok: false, kind: 'unknown-session' }),
    'session:permission:answer': () => ({ ok: false, kind: 'unknown-session' }),
    'session:invoke': () => ({ ok: false, kind: 'unknown-session' }),
    'session:dismiss': () => ({ ok: false, kind: 'unknown-session' }),
    'session:restore': () => ({ ok: false, kind: 'unknown-restore' }),
    'session:restore:discard': () => ({ ok: true }),
  }
}
