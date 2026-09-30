import { describe, expect, it, vi } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { SessionKey } from '../../shared/hosting/types'
import type { RegistryDeps } from '../registry'
import type { HostedStore } from '../hosting'
import {
  resolveSessionAttach,
  resolveSessionClose,
  resolveSessionInterrupt,
  resolveSessionList,
  resolveSessionPermissionAnswer,
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
    commands: { worktrees: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
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
    ...overrides,
  }
}

function depsWith(overrides: Partial<HostingChannelDeps> = {}): HostingChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
    store: storeStub(),
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

  it('rejects empty text', () => {
    expect(() => resolveSessionSend({ sessionKey: SESSION_KEY, text: '' }, depsWith())).toThrow("'session:send' requires a non-empty 'text'")
  })

  it('delegates to the store', () => {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u', queued: true }))
    resolveSessionSend({ sessionKey: SESSION_KEY, text: 'hi' }, depsWith({ store: storeStub({ send }) }))
    expect(send).toHaveBeenCalledWith(SESSION_KEY, 'hi')
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
