import { describe, expect, it } from 'vitest'
import type { SessionKey } from '@/types/hosting'
import { resolveSessionControlsSet, resolveSessionPlanAnswer, resolveSessionQuestionAnswer } from '@/main/channels/hosting'
import type { HostingChannelDeps } from '@/types/channels'
import { storeStub } from '../../../fixtures/store'

const SESSION_KEY = 'hosted-1' as SessionKey

function depsWith(overrides: Partial<HostingChannelDeps> = {}): HostingChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] }),
    store: storeStub(),
    sessionIndex: { load: () => Promise.resolve(), observe: () => undefined, list: () => [] },
    listSessionFiles: () => {
      throw new Error('listSessionFiles should not be invoked in this case')
    },
    resolveStartTarget: () => {
      throw new Error('resolveStartTarget should not be invoked in this case')
    },
    targetDeps: {
      git: () => {
        throw new Error('git should not be invoked in this case')
      },
      recents: { load: () => Promise.resolve([]), record: () => Promise.resolve() },
      exists: () => Promise.resolve(true),
      readSessions: () => Promise.resolve({ ok: true, sessions: [] }),
      createWorktree: () => Promise.resolve({ ok: false, message: 'should not be called' }),
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    removeCreatedWorktree: () => Promise.resolve(),
    ...overrides,
  }
}

describe('resolveSessionControlsSet', () => {
  it('rejects an empty sessionKey', () => {
    expect(() => resolveSessionControlsSet({ sessionKey: '' as SessionKey }, depsWith())).toThrow("'session:controls:set' requires a non-empty 'sessionKey'")
  })

  it('rejects a request with none of permissionMode/model/effort', () => {
    expect(() => resolveSessionControlsSet({ sessionKey: SESSION_KEY }, depsWith())).toThrow("'session:controls:set' requires at least one of 'permissionMode', 'model', or 'effort'")
  })

  it('rejects an unlisted permissionMode', () => {
    expect(() => resolveSessionControlsSet({ sessionKey: SESSION_KEY, permissionMode: 'bypassPermissions' as never }, depsWith())).toThrow(/permissionMode/)
  })

  it('rejects an unlisted effort', () => {
    expect(() => resolveSessionControlsSet({ sessionKey: SESSION_KEY, effort: 'extreme' as never }, depsWith())).toThrow(/effort/)
  })
})

describe('resolveSessionQuestionAnswer', () => {
  it('rejects a non-object answers', () => {
    expect(() => resolveSessionQuestionAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', answers: null as never }, depsWith())).toThrow(/plain object/)
  })

  it('rejects a non-string answer value', () => {
    expect(() => resolveSessionQuestionAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', answers: { Q: 1 as never } }, depsWith())).toThrow(/string/)
  })
})

describe('resolveSessionPlanAnswer', () => {
  it('rejects an approve decision whose mode is plan', () => {
    expect(() => resolveSessionPlanAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', decision: { kind: 'approve', mode: 'plan' as never } }, depsWith())).toThrow(/mode/)
  })

  it('rejects an empty keep-planning feedback', () => {
    expect(() => resolveSessionPlanAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', decision: { kind: 'keep-planning', feedback: '' } }, depsWith())).toThrow(/feedback/)
  })
})
