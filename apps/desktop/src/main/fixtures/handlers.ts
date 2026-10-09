// One handler per `IpcChannel`, so the exhaustive `FixtureHandlers` type fails `pnpm typecheck` when a new channel ships with none. No handler throws or causes a side effect.
import type { IpcChannel, IpcMap } from '../../shared/ipc'
import type { RepoRunState } from '../../shared/dispatch/types'
import { RUN_TARGET } from '../../shared/dispatch/types'
import type { TranscriptSource } from '../../shared/sessions/transcript'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import { fixtureBoardSnapshot } from './board'
import { fixtureBacklog } from './backlog'
import { fixtureClaimPreflight, fixtureGatePreflight } from './dialogs'
import { FIXTURE_REPOSITORIES } from './repos'
import { fixtureAttachEntries, fixturePermissionSnapshots, fixtureSearchResult, fixtureSessionAttach, fixtureSessionsScan, fixtureSessionSnapshots } from './sessions'
import type { FixtureScenario } from './mode'
import { fixtureWorktreesReclaim, fixtureWorktreesReport } from './worktrees'

/** Exhaustive by construction: a new `IpcChannel` fails `pnpm typecheck` in
 *  `fixtureHandlers`'s own return literal until a fixture exists for it. */
export type FixtureHandlers = { readonly [C in IpcChannel]: (request: IpcMap[C]['request']) => IpcMap[C]['response'] }

function transcriptSourceFor(sessionId: string, agentId: string | null, now: Date): TranscriptSource {
  return { sessionId, agentId, path: '', sizeBytes: 0, modifiedAt: now.toISOString(), recordCount: 0, malformedLines: 0 }
}

export function fixtureHandlers(now: Date, scenario: FixtureScenario = 'populated'): FixtureHandlers {
  return {
    // --- Screen reads, populated -------------------------------------------
    'app:info': () => ({ app: '0.1.0', electron: '38.2.1', node: '22.14.0', chromium: '140.0.0.0' }),

    'repos:list': () => ({ ok: true, repositories: FIXTURE_REPOSITORIES }),

    'board:snapshot': () => fixtureBoardSnapshot(now, scenario),
    'board:refresh': () => fixtureBoardSnapshot(now, scenario),

    'runtime:preflight': () => ({
      checkedAt: now.toISOString(),
      executable: { path: '/usr/local/bin/claude' },
      version: { raw: '2.1.3', belowMinimum: false },
      credentials: { present: true, expiresAt: null, hasRefreshToken: true },
      apiKeyInEnvironment: false,
      diagnosis: 'unverified',
      detail: null,
    }),

    'sessions:scan': () => fixtureSessionsScan(now),

    'session:list': () => (scenario === 'empty' ? fixturePermissionSnapshots(now) : fixtureSessionSnapshots(now)),
    'session:capacity': () => ({ limit: 4, ceiling: 8 }),
    'session:capacity:set': () => ({ limit: 4, ceiling: 8 }),
    'session:restore:list': () => ({ entries: [] }),

    // --- Click-only reads, valid and populated ------------------------------
    'worktrees:report': () => fixtureWorktreesReport(now),
    'worktrees:reclaim': () => fixtureWorktreesReclaim(now),

    'transcript:tail:open': (request) => ({ ok: true, tailId: 'fixture-tail', source: transcriptSourceFor(request.sessionId, request.agentId, now), entries: fixtureAttachEntries(now) }),
    'transcript:tail:poll': () => ({ ok: true, source: transcriptSourceFor('fixture-session', null, now), appended: [], patched: [], hasMore: false }),
    'transcript:tail:close': () => undefined,

    'search:query': () => fixtureSearchResult(now),

    'claim:preflight': () => fixtureClaimPreflight(now),
    'gate:preflight': () => fixtureGatePreflight(now),

    'runtime:probe': (request) => ({ checkedAt: now.toISOString(), repo: request.repoId === null ? null : 'acme/widgets', elapsedMs: 420, apiKeyInEnvironment: false, diagnosis: 'verified', detail: null }),

    // --- Writes, never a side effect ---------------------------------------
    'repos:add': () => ({ ok: true, outcome: 'cancelled' }),
    'repos:remove': () => ({ ok: true, repositories: FIXTURE_REPOSITORIES }),

    'item:action': () => ({ ok: true, outcome: { kind: 'no-op' } }),

    'item:decide': () => ({ ok: true, comment: null, labels: { kind: 'no-op' } }),

    'dispatch:control': (request) => {
      if (request.command === 'halt') return { ok: true, command: 'halt', report: { kind: 'completed', items: [] }, released: true }
      if (request.command === 'take-over') return { ok: true, command: 'take-over', repoId: request.repoId, runState: { repoId: request.repoId, state: RUN_TARGET.run, since: now.toISOString() } }
      const runState: RepoRunState = { repoId: request.repoId, state: RUN_TARGET[request.command], since: now.toISOString() }
      if (request.command === 'run') return { ok: true, command: 'run', repoId: request.repoId, runState }
      if (request.command === 'drain') return { ok: true, command: 'drain', repoId: request.repoId, runState, persisted: false }
      return { ok: true, command: 'pause', repoId: request.repoId, runState, report: { kind: 'completed', items: [] }, released: true }
    },

    'claim:apply': () => ({ kind: 'refused', verdict: { kind: 'not-found' } }),

    'gate:answer': () => ({ kind: 'refused', verdict: { kind: 'not-found' } }),

    'session:start': () => ({ ok: false, kind: 'runtime', diagnosis: 'unverified', detail: 'Fixture mode: sessions are not started.' }),
    'session:send': () => ({ ok: false, kind: 'unknown-session' }),
    'session:interrupt': () => ({ ok: false, kind: 'unknown-session' }),
    'session:close': () => ({ ok: false, kind: 'unknown-session' }),
    'session:attach': (request) => fixtureSessionAttach(request.sessionKey, now),
    'session:permission:answer': () => ({ ok: false, kind: 'unknown-session' }),
    'session:invoke': () => ({ ok: false, kind: 'unknown-session' }),
    'session:dismiss': () => ({ ok: false, kind: 'unknown-session' }),
    'session:restore': () => ({ ok: false, kind: 'unknown-restore' }),
    'session:restore:discard': () => ({ ok: true }),

    'gh:status': () => ({ kind: 'signed-in', checkedAt: now.toISOString() }),
    'backlog:list': (request) => fixtureBacklog(now, request.repoId),
    'session:defaults': () => DEFAULT_SESSION_DEFAULTS,
    'session:defaults:set': (request) => request,
    'session:rename': () => ({ ok: false, kind: 'unknown-session' }),
    'session:controls:set': () => ({ ok: false, kind: 'unknown-session' }),
    'session:question:answer': () => ({ ok: false, kind: 'unknown-session' }),
    'session:plan:answer': () => ({ ok: false, kind: 'unknown-session' }),
    'session:files': () => ({ ok: false, kind: 'unknown-session' }),
  }
}
