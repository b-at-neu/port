import { describe, expect, it, vi } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { SessionKey } from '../../shared/hosting/types'
import type { RegistryDeps } from '../registry'
import type { HostedStore } from '../hosting/store'
import {
  MAX_INVOKE_ARGS_CHARS,
  resolveSessionAttach,
  resolveSessionCapacity,
  resolveSessionCapacitySet,
  resolveSessionClose,
  resolveSessionDefaults,
  resolveSessionDefaultsSet,
  resolveSessionDismiss,
  resolveSessionInterrupt,
  resolveSessionInvoke,
  resolveSessionList,
  resolveSessionPermissionAnswer,
  resolveSessionRename,
  resolveSessionRestore,
  resolveSessionRestoreDiscard,
  resolveSessionRestoreList,
  resolveSessionSend,
  resolveSessionStart,
} from './hosting'
import type { HostingChannelDeps } from './hosting'

const REPO_ID = 'repo-1' as unknown as RepoId
const SESSION_KEY = 'hosted-1' as SessionKey

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by the hosting channel')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: {} as never,
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

const NOT_READY_ENTRY = { id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }

function storeStub(overrides: Partial<HostedStore> = {}): HostedStore {
  return {
    start: () => {
      throw new Error('start should not be invoked in this case')
    },
    send: () => {
      throw new Error('send should not be invoked in this case')
    },
    interrupt: () => {
      throw new Error('interrupt should not be invoked in this case')
    },
    close: () => {
      throw new Error('close should not be invoked in this case')
    },
    attach: () => {
      throw new Error('attach should not be invoked in this case')
    },
    list: () => {
      throw new Error('list should not be invoked in this case')
    },
    closeAll: () => {
      throw new Error('closeAll should not be invoked in this case')
    },
    answerPermission: () => {
      throw new Error('answerPermission should not be invoked in this case')
    },
    invoke: () => {
      throw new Error('invoke should not be invoked in this case')
    },
    dismiss: () => {
      throw new Error('dismiss should not be invoked in this case')
    },
    snapshotOf: () => {
      throw new Error('snapshotOf should not be invoked in this case')
    },
    cwdOf: () => {
      throw new Error('cwdOf should not be invoked in this case')
    },
    capacity: () => {
      throw new Error('capacity should not be invoked in this case')
    },
    setLimit: () => {
      throw new Error('setLimit should not be invoked in this case')
    },
    defaults: () => {
      throw new Error('defaults should not be invoked in this case')
    },
    setDefaults: () => {
      throw new Error('setDefaults should not be invoked in this case')
    },
    rename: () => {
      throw new Error('rename should not be invoked in this case')
    },
    restorable: () => {
      throw new Error('restorable should not be invoked in this case')
    },
    restore: () => {
      throw new Error('restore should not be invoked in this case')
    },
    discardRestorable: () => {
      throw new Error('discardRestorable should not be invoked in this case')
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
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
    store: storeStub(),
    listSessionFiles: () => {
      throw new Error('listSessionFiles should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveSessionStart', () => {
  it('rejects a missing repoId', async () => {
    await expect(resolveSessionStart(registryDeps, { repoId: undefined as unknown as RepoId, mode: { kind: 'fresh' } }, depsWith())).rejects.toThrow(
      "'session:start' requires a non-empty 'repoId'",
    )
  })

  it('rejects an unregistered repoId', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'fresh' } }, deps)).rejects.toThrow(
      `found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects a non-ready repoId', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'fresh' } }, deps)).rejects.toThrow("requires a 'ready' repository")
  })

  it('rejects an unrecognised mode.kind', async () => {
    await expect(resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'bogus' } as never }, depsWith())).rejects.toThrow(
      "'session:start' requires 'mode.kind' to be one of fresh | resume | resume-at | fork",
    )
  })

  it('rejects resume with no sessionId', async () => {
    await expect(resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'resume', sessionId: '' } as never }, depsWith())).rejects.toThrow(
      "'session:start' requires 'mode.kind'",
    )
  })

  it('rejects resume-at with no messageUuid', async () => {
    await expect(
      resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'resume-at', sessionId: 'x', messageUuid: '' } as never }, depsWith()),
    ).rejects.toThrow("'session:start' requires 'mode.kind'")
  })

  it('accepts fresh and delegates to the store with the ready entry path as cwd', async () => {
    const start = vi.fn(() => Promise.resolve({ ok: true as const, snapshot: {} as never }))
    const deps = depsWith({ store: storeStub({ start }) })
    await resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'fresh' } }, deps)
    expect(start).toHaveBeenCalledWith({ repoId: REPO_ID, mode: { kind: 'fresh' }, cwd: '/repo' })
  })

  it('accepts resume-at with resumeDropsTurn omitted', async () => {
    const start = vi.fn(() => Promise.resolve({ ok: true as const, snapshot: {} as never }))
    const deps = depsWith({ store: storeStub({ start }) })
    await resolveSessionStart(registryDeps, { repoId: REPO_ID, mode: { kind: 'resume-at', sessionId: 'x', messageUuid: 'y' } as never }, deps)
    expect(start).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSessionSend', () => {
  it('rejects a missing sessionKey', () => {
    expect(() => resolveSessionSend({ sessionKey: undefined as unknown as SessionKey, text: 'hi' }, depsWith())).toThrow(
      "'session:send' requires a non-empty 'sessionKey'",
    )
  })

  it('rejects empty text with no attachments', () => {
    expect(() => resolveSessionSend({ sessionKey: SESSION_KEY, text: '' }, depsWith())).toThrow("'session:send' requires a non-empty 'text' when there are no attachments")
  })

  it('delegates to the store', () => {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u', queued: true }))
    resolveSessionSend({ sessionKey: SESSION_KEY, text: 'hi' }, depsWith({ store: storeStub({ send }) }))
    expect(send).toHaveBeenCalledWith(SESSION_KEY, 'hi', [])
  })

})

describe('resolveSessionInterrupt / resolveSessionClose / resolveSessionAttach', () => {
  it('all reject a missing sessionKey', () => {
    const deps = depsWith()
    expect(() => resolveSessionInterrupt({ sessionKey: '' as SessionKey }, deps)).toThrow("'session:interrupt' requires a non-empty 'sessionKey'")
    expect(() => resolveSessionClose({ sessionKey: '' as SessionKey }, deps)).toThrow("'session:close' requires a non-empty 'sessionKey'")
    expect(() => resolveSessionAttach({ sessionKey: '' as SessionKey }, deps)).toThrow("'session:attach' requires a non-empty 'sessionKey'")
  })
})

describe('resolveSessionList', () => {
  it('rejects a payload', () => {
    expect(() => resolveSessionList({} as unknown as void, depsWith())).toThrow("'session:list' takes no payload")
  })

  it('delegates to the store', () => {
    const list = vi.fn(() => [])
    resolveSessionList(undefined, depsWith({ store: storeStub({ list }) }))
    expect(list).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSessionInvoke', () => {
  it('rejects a missing sessionKey', () => {
    expect(() => resolveSessionInvoke({ sessionKey: '' as SessionKey, name: 'pipeline', args: '' }, depsWith())).toThrow(
      "'session:invoke' requires a non-empty 'sessionKey'",
    )
  })

  it('rejects an empty name', () => {
    expect(() => resolveSessionInvoke({ sessionKey: SESSION_KEY, name: '', args: '' }, depsWith())).toThrow("'session:invoke' requires a non-empty 'name'")
  })

  it('rejects args over the character cap', () => {
    expect(() => resolveSessionInvoke({ sessionKey: SESSION_KEY, name: 'pipeline', args: 'x'.repeat(MAX_INVOKE_ARGS_CHARS + 1) }, depsWith())).toThrow(
      `'session:invoke' requires 'args' to be a string of at most ${MAX_INVOKE_ARGS_CHARS} characters`,
    )
  })

  it('delegates to the store, never validating the name itself here', () => {
    const invoke = vi.fn(() => ({ ok: true as const, uuid: 'u', queued: true }))
    resolveSessionInvoke({ sessionKey: SESSION_KEY, name: '/not-canonical', args: 'hi' }, depsWith({ store: storeStub({ invoke }) }))
    expect(invoke).toHaveBeenCalledWith(SESSION_KEY, '/not-canonical', 'hi')
  })
})

describe('resolveSessionPermissionAnswer', () => {
  const base = { sessionKey: SESSION_KEY, permissionId: 'perm-1', decision: 'deny' as const, message: null }

  it('rejects a missing sessionKey', () => {
    expect(() => resolveSessionPermissionAnswer({ ...base, sessionKey: '' as SessionKey }, depsWith())).toThrow(
      "'session:permission:answer' requires a non-empty 'sessionKey'",
    )
  })

  it('rejects a missing permissionId', () => {
    expect(() => resolveSessionPermissionAnswer({ ...base, permissionId: '' }, depsWith())).toThrow(
      "'session:permission:answer' requires a non-empty 'permissionId'",
    )
  })

  it('rejects an unrecognised decision', () => {
    expect(() => resolveSessionPermissionAnswer({ ...base, decision: 'bogus' as never }, depsWith())).toThrow(
      "'session:permission:answer' requires 'decision' to be one of allow-once, allow-session, deny",
    )
  })

  it('rejects an empty-string message', () => {
    expect(() => resolveSessionPermissionAnswer({ ...base, message: '' }, depsWith())).toThrow(
      "'session:permission:answer' requires 'message' to be null or a string of 1-2000 characters",
    )
  })

  it('rejects a message over 2000 characters', () => {
    expect(() => resolveSessionPermissionAnswer({ ...base, message: 'x'.repeat(2001) }, depsWith())).toThrow(
      "'session:permission:answer' requires 'message' to be null or a string of 1-2000 characters",
    )
  })

  it('rejects a non-null message alongside a decision other than deny', () => {
    expect(() => resolveSessionPermissionAnswer({ ...base, decision: 'allow-once', message: 'why' }, depsWith())).toThrow(
      "'session:permission:answer' requires 'message' to be null when 'decision' is not 'deny'",
    )
  })

  it('delegates to the store with the validated request', () => {
    const answerPermission = vi.fn(() => ({ ok: true as const }))
    resolveSessionPermissionAnswer({ ...base, message: 'no thanks' }, depsWith({ store: storeStub({ answerPermission }) }))
    expect(answerPermission).toHaveBeenCalledWith(SESSION_KEY, 'perm-1', 'deny', 'no thanks')
  })
})

describe('resolveSessionDismiss', () => {
  it('rejects a missing sessionKey', () => {
    expect(() => resolveSessionDismiss({ sessionKey: '' as SessionKey }, depsWith())).toThrow("'session:dismiss' requires a non-empty 'sessionKey'")
  })

  it('delegates to the store', () => {
    const dismiss = vi.fn(() => ({ ok: true as const }))
    resolveSessionDismiss({ sessionKey: SESSION_KEY }, depsWith({ store: storeStub({ dismiss }) }))
    expect(dismiss).toHaveBeenCalledWith(SESSION_KEY)
  })
})

describe('resolveSessionCapacity', () => {
  it('rejects a payload', () => {
    expect(() => resolveSessionCapacity({} as unknown as void, depsWith())).toThrow("'session:capacity' takes no payload")
  })

  it('delegates to the store', async () => {
    const capacity = vi.fn(() => Promise.resolve({ limit: 4, ceiling: 8 }))
    await resolveSessionCapacity(undefined, depsWith({ store: storeStub({ capacity }) }))
    expect(capacity).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSessionCapacitySet', () => {
  it('rejects a non-integer limit', () => {
    expect(() => resolveSessionCapacitySet({ limit: 1.5 }, depsWith())).toThrow("'session:capacity:set' requires 'limit' to be an integer from 1 to 8")
  })

  it('rejects a limit below 1', () => {
    expect(() => resolveSessionCapacitySet({ limit: 0 }, depsWith())).toThrow("'session:capacity:set' requires 'limit' to be an integer from 1 to 8")
  })

  it('rejects a limit above the ceiling', () => {
    expect(() => resolveSessionCapacitySet({ limit: 9 }, depsWith())).toThrow("'session:capacity:set' requires 'limit' to be an integer from 1 to 8")
  })

  it('delegates to the store', () => {
    const setLimit = vi.fn(() => Promise.resolve({ limit: 3, ceiling: 8 }))
    void resolveSessionCapacitySet({ limit: 3 }, depsWith({ store: storeStub({ setLimit }) }))
    expect(setLimit).toHaveBeenCalledWith(3)
  })
})

describe('resolveSessionRestoreList', () => {
  it('rejects a payload', async () => {
    await expect(resolveSessionRestoreList(registryDeps, {} as unknown as void, depsWith())).rejects.toThrow("'session:restore:list' takes no payload")
  })

  it('marks a ready repository available', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: 'Title', startedAt: 't1' }]),
    )
    const result = await resolveSessionRestoreList(registryDeps, undefined, depsWith({ store: storeStub({ restorable }) }))
    expect(result.entries).toEqual([
      { restoreId: 'restore-1', repoId: REPO_ID, title: 'Title', origin: { kind: 'resumed', from: 'session-1' }, startedAt: 't1', availability: { ok: true } },
    ])
  })

  it('marks a not-ready repository unavailable with its problem reason', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }]),
    )
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }), store: storeStub({ restorable }) })
    const result = await resolveSessionRestoreList(registryDeps, undefined, deps)
    expect(result.entries[0]?.availability).toEqual({ ok: false, reason: 'its folder is gone' })
  })

  it('marks every entry unavailable when the listing itself fails', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }]),
    )
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'nope' }), store: storeStub({ restorable }) })
    const result = await resolveSessionRestoreList(registryDeps, undefined, deps)
    expect(result.entries[0]?.availability).toEqual({ ok: false, reason: 'nope' })
  })
})

describe('resolveSessionRestore', () => {
  it('rejects a missing restoreId', async () => {
    await expect(resolveSessionRestore(registryDeps, { restoreId: '' }, depsWith())).rejects.toThrow("'session:restore' requires a non-empty 'restoreId'")
  })

  it('reports unknown-restore for an id no entry carries', async () => {
    const deps = depsWith({ store: storeStub({ restorable: () => Promise.resolve([]) }) })
    await expect(resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)).resolves.toEqual({ ok: false, kind: 'unknown-restore' })
  })

  it('reports repo-unavailable rather than throwing when the repository is not ready', async () => {
    const restorable = () => Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }])
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }), store: storeStub({ restorable }) })
    await expect(resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)).resolves.toEqual({ ok: false, kind: 'repo-unavailable', reason: 'its folder is gone' })
  })

  it('resolves the ready path itself and delegates to the store', async () => {
    const restorable = () => Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }])
    const restore = vi.fn(() => Promise.resolve({ ok: true as const, snapshot: {} as never }))
    const deps = depsWith({ store: storeStub({ restorable, restore }) })
    await resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)
    expect(restore).toHaveBeenCalledWith('restore-1', '/repo')
  })
})

describe('resolveSessionRestoreDiscard', () => {
  it('rejects an empty-string restoreId', () => {
    expect(() => resolveSessionRestoreDiscard({ restoreId: '' }, depsWith())).toThrow("'session:restore:discard' requires 'restoreId' to be null or a non-empty string")
  })

  it('delegates null through to discard every entry', () => {
    const discardRestorable = vi.fn(() => Promise.resolve({ ok: true as const }))
    void resolveSessionRestoreDiscard({ restoreId: null }, depsWith({ store: storeStub({ discardRestorable }) }))
    expect(discardRestorable).toHaveBeenCalledWith(null)
  })

  it('delegates a specific restoreId', () => {
    const discardRestorable = vi.fn(() => Promise.resolve({ ok: true as const }))
    void resolveSessionRestoreDiscard({ restoreId: 'restore-1' }, depsWith({ store: storeStub({ discardRestorable }) }))
    expect(discardRestorable).toHaveBeenCalledWith('restore-1')
  })
})

describe('resolveSessionDefaults', () => {
  it('rejects a payload', () => {
    expect(() => resolveSessionDefaults({} as unknown as undefined, depsWith())).toThrow("'session:defaults' takes no payload")
  })

  it('delegates to store.defaults()', () => {
    const defaults = vi.fn(() => Promise.resolve({ model: null, permissionMode: 'default' as const }))
    void resolveSessionDefaults(undefined, depsWith({ store: storeStub({ defaults }) }))
    expect(defaults).toHaveBeenCalled()
  })
})

describe('resolveSessionDefaultsSet', () => {
  it('rejects an out-of-list model', () => {
    expect(() => resolveSessionDefaultsSet({ model: 'gpt-5', permissionMode: 'default' } as never, depsWith())).toThrow(
      "'session:defaults:set' requires 'model' to be null or one of opus, sonnet, haiku",
    )
  })

  it('rejects an out-of-list permissionMode', () => {
    expect(() => resolveSessionDefaultsSet({ model: null, permissionMode: 'bypassPermissions' } as never, depsWith())).toThrow(
      "'session:defaults:set' requires 'permissionMode' to be one of default, acceptEdits, plan",
    )
  })

  it('delegates a valid payload', () => {
    const setDefaults = vi.fn(() => Promise.resolve({ model: 'opus' as const, permissionMode: 'acceptEdits' as const }))
    void resolveSessionDefaultsSet({ model: 'opus', permissionMode: 'acceptEdits' }, depsWith({ store: storeStub({ setDefaults }) }))
    expect(setDefaults).toHaveBeenCalledWith({ model: 'opus', permissionMode: 'acceptEdits' })
  })
})

describe('resolveSessionRename', () => {
  it('rejects an empty-string sessionKey', () => {
    expect(() => resolveSessionRename({ sessionKey: '' as SessionKey, title: 'New title' }, depsWith())).toThrow("'session:rename' requires a non-empty 'sessionKey'")
  })

  it('rejects an empty or whitespace-only title', () => {
    expect(() => resolveSessionRename({ sessionKey: SESSION_KEY, title: '   ' }, depsWith())).toThrow(
      "'session:rename' requires 'title' to be non-empty and at most 80 characters once trimmed",
    )
  })

  it('rejects a title over SESSION_TITLE_MAX once trimmed', () => {
    expect(() => resolveSessionRename({ sessionKey: SESSION_KEY, title: 'x'.repeat(81) }, depsWith())).toThrow(
      "'session:rename' requires 'title' to be non-empty and at most 80 characters once trimmed",
    )
  })

  it('delegates the trimmed title', () => {
    const rename = vi.fn(() => Promise.resolve({ ok: true as const }))
    void resolveSessionRename({ sessionKey: SESSION_KEY, title: '  New title  ' }, depsWith({ store: storeStub({ rename }) }))
    expect(rename).toHaveBeenCalledWith(SESSION_KEY, 'New title')
  })
})
