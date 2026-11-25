import { describe, expect, it } from 'vitest'
import { freeSlots, liveCount, survived } from '@/main/dispatch/launch'
import type { ResolvedItem } from '@/types/github'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { TickActionable } from '@/types/tick'
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    repoId: 'repo-a' as RepoId,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending' },
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

describe('liveCount / freeSlots', () => {
  it('counts only non-ended snapshots', () => {
    expect(liveCount([snapshot({ phase: 'ready' }), snapshot({ phase: 'ended' }), snapshot({ phase: 'streaming' })])).toBe(2)
  })

  it('never returns a negative free count', () => {
    expect(freeSlots(1, [snapshot(), snapshot({ sessionKey: 'hosted-2' as SessionKey })])).toBe(0)
  })

  it('reports the remainder under the limit', () => {
    expect(freeSlots(4, [snapshot()])).toBe(3)
  })
})

const VOCABULARY = resolveVocabulary({})
const CANDIDATE = { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null } as TickActionable

function resolved(labels: readonly string[], assignees: readonly string[] = ['op']): ResolvedItem {
  return { number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels, assignees, headRefName: null, author: null }
}

describe('survived — store labels', () => {
  it('does not survive an unseeded repository, even when GitHub shows the trigger', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, VOCABULARY, 'op', null)).toBe(false)
  })

  it('survives on the store\'s stage even when every label was removed on GitHub', () => {
    expect(survived(resolved([]), CANDIDATE, VOCABULARY, 'op', ['claude', 'plan approved'])).toBe(true)
  })

  it('does not survive a trigger the store no longer holds, even when GitHub still shows it', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, VOCABULARY, 'op', ['claude', 'in progress'])).toBe(false)
  })

  it('does not dispatch an item the store does not track, even when GitHub shows the trigger', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, VOCABULARY, 'op', [])).toBe(false)
  })

  it('applies no single-label rule: another stage label beside the trigger changes nothing', () => {
    expect(survived(resolved([]), CANDIDATE, VOCABULARY, 'op', ['plan approved', 'in progress'])).toBe(true)
  })

  it('still takes the assignees from GitHub', () => {
    expect(survived(resolved([], ['someone-else']), CANDIDATE, VOCABULARY, 'op', ['plan approved'])).toBe(false)
  })
})
