import { describe, expect, it } from 'vitest'
import { MAX_JUMP_SESSIONS, orderSessions } from '@/utils/shell/session-order'
import type { HostedSessionSnapshot, SessionKey, SessionMarks } from '@/types/hosting'
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import type { RepoId } from '@/utils/repos'
import type { StageTag } from '@/types/stage-session'

const REPO_ID = 'repo-1' as RepoId
const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    repoId: REPO_ID,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00.000Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: null,
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
    usage: null,
    backgroundTasks: [],
    stage: null,
    lastResult: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

function marks(pinned: readonly string[]): SessionMarks {
  return { pinned, archived: [] }
}

describe('orderSessions', () => {
  it('moves pinned sessions first, keeping each group\'s own order', () => {
    const a = snapshot({ sessionKey: 'a' as SessionKey, claudeSessionId: 'claude-a' })
    const b = snapshot({ sessionKey: 'b' as SessionKey, claudeSessionId: 'claude-b' })
    const c = snapshot({ sessionKey: 'c' as SessionKey, claudeSessionId: 'claude-c' })
    const ordered = orderSessions([a, b, c], marks(['claude-c']))
    expect(ordered.map((s) => s.sessionKey)).toEqual(['c', 'a', 'b'])
  })

  it('excludes ended and stage sessions', () => {
    const live = snapshot({ sessionKey: 'live' as SessionKey })
    const ended = snapshot({ sessionKey: 'ended' as SessionKey, phase: 'ended' })
    const stage = snapshot({ sessionKey: 'stage' as SessionKey, stage: { agent: 'impl', number: 1, kind: 'issue', trigger: 'planApproved' } as StageTag })
    const ordered = orderSessions([live, ended, stage], undefined)
    expect(ordered.map((s) => s.sessionKey)).toEqual(['live'])
  })

  it('uses plain list order when marks have not loaded', () => {
    const a = snapshot({ sessionKey: 'a' as SessionKey, claudeSessionId: 'claude-a' })
    const b = snapshot({ sessionKey: 'b' as SessionKey, claudeSessionId: 'claude-b' })
    expect(orderSessions([a, b], undefined).map((s) => s.sessionKey)).toEqual(['a', 'b'])
  })

  it('never treats a session with no claudeSessionId as pinned', () => {
    const a = snapshot({ sessionKey: 'a' as SessionKey, claudeSessionId: null })
    const b = snapshot({ sessionKey: 'b' as SessionKey, claudeSessionId: 'claude-b' })
    const ordered = orderSessions([a, b], marks(['claude-a']))
    expect(ordered.map((s) => s.sessionKey)).toEqual(['a', 'b'])
  })

  it('exports the jump cap', () => {
    expect(MAX_JUMP_SESSIONS).toBe(9)
  })
})
