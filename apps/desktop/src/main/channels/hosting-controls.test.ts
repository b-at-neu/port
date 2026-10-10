import { describe, expect, it, vi } from 'vitest'
import type { SessionKey } from '../../shared/hosting/types'
import type { HostedStore } from '../hosting/store'
import { resolveSessionControlsSet, resolveSessionPlanAnswer, resolveSessionQuestionAnswer } from './hosting'
import type { HostingChannelDeps } from './hosting'

const SESSION_KEY = 'hosted-1' as SessionKey

function storeStub(overrides: Partial<HostedStore> = {}): HostedStore {
  return {
    start: () => {
      throw new Error('unused in this test')
    },
    send: () => {
      throw new Error('unused in this test')
    },
    interrupt: () => {
      throw new Error('unused in this test')
    },
    close: () => {
      throw new Error('unused in this test')
    },
    attach: () => {
      throw new Error('unused in this test')
    },
    list: () => {
      throw new Error('unused in this test')
    },
    closeAll: () => {
      throw new Error('unused in this test')
    },
    answerPermission: () => {
      throw new Error('unused in this test')
    },
    invoke: () => {
      throw new Error('unused in this test')
    },
    dismiss: () => {
      throw new Error('unused in this test')
    },
    snapshotOf: () => {
      throw new Error('unused in this test')
    },
    cwdOf: () => {
      throw new Error('cwdOf should not be invoked in this case')
    },
    capacity: () => {
      throw new Error('unused in this test')
    },
    setLimit: () => {
      throw new Error('unused in this test')
    },
    defaults: () => {
      throw new Error('unused in this test')
    },
    setDefaults: () => {
      throw new Error('unused in this test')
    },
    rename: () => {
      throw new Error('unused in this test')
    },
    restorable: () => {
      throw new Error('unused in this test')
    },
    restore: () => {
      throw new Error('unused in this test')
    },
    discardRestorable: () => {
      throw new Error('unused in this test')
    },
    marks: () => {
      throw new Error('unused in this test')
    },
    setMark: () => {
      throw new Error('unused in this test')
    },
    setControls: () => {
      throw new Error('setControls should not be invoked in this case')
    },
    answerQuestion: () => {
      throw new Error('answerQuestion should not be invoked in this case')
    },
    answerPlan: () => {
      throw new Error('answerPlan should not be invoked in this case')
    },
    ...overrides,
  }
}

function depsWith(overrides: Partial<HostingChannelDeps> = {}): HostingChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] }),
    store: storeStub(),
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

  it('delegates a valid patch', () => {
    const setControls = vi.fn(() => Promise.resolve({ ok: true as const, controls: { permissionMode: 'acceptEdits' as const, model: null, effort: null } }))
    void resolveSessionControlsSet({ sessionKey: SESSION_KEY, permissionMode: 'acceptEdits' }, depsWith({ store: storeStub({ setControls }) }))
    expect(setControls).toHaveBeenCalledWith(SESSION_KEY, { permissionMode: 'acceptEdits', model: undefined, effort: undefined })
  })
})

describe('resolveSessionQuestionAnswer', () => {
  it('rejects a non-object answers', () => {
    expect(() => resolveSessionQuestionAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', answers: null as never }, depsWith())).toThrow(/plain object/)
  })

  it('rejects a non-string answer value', () => {
    expect(() => resolveSessionQuestionAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', answers: { Q: 1 as never } }, depsWith())).toThrow(/string/)
  })

  it('delegates valid answers', () => {
    const answerQuestion = vi.fn(() => ({ ok: true as const }))
    void resolveSessionQuestionAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', answers: { Q: 'A' } }, depsWith({ store: storeStub({ answerQuestion }) }))
    expect(answerQuestion).toHaveBeenCalledWith(SESSION_KEY, 'p1', { Q: 'A' })
  })
})

describe('resolveSessionPlanAnswer', () => {
  it('rejects an approve decision whose mode is plan', () => {
    expect(() => resolveSessionPlanAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', decision: { kind: 'approve', mode: 'plan' as never } }, depsWith())).toThrow(/mode/)
  })

  it('rejects an empty keep-planning feedback', () => {
    expect(() => resolveSessionPlanAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', decision: { kind: 'keep-planning', feedback: '' } }, depsWith())).toThrow(/feedback/)
  })

  it('delegates a valid approve decision', () => {
    const answerPlan = vi.fn(() => ({ ok: true as const }))
    void resolveSessionPlanAnswer({ sessionKey: SESSION_KEY, permissionId: 'p1', decision: { kind: 'approve', mode: 'acceptEdits' } }, depsWith({ store: storeStub({ answerPlan }) }))
    expect(answerPlan).toHaveBeenCalledWith(SESSION_KEY, 'p1', { kind: 'approve', mode: 'acceptEdits' })
  })
})
