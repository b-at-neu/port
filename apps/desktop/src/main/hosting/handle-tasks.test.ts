import { describe, expect, it, vi } from 'vitest'
import { createHostedHandle } from './handle'
import type { HostedQuery } from './handle'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import type { PluginRequest, SessionKey } from '../../shared/hosting/types'
import type { RepoId } from '../../shared/repos'
import type { SessionWorkspace } from '../../shared/workspace/types'

const SESSION_KEY = 'hosted-1' as SessionKey
const REPO_ID = 'repo-1' as RepoId
const INSTALLED_PLUGIN: PluginRequest = { source: 'installed' }
const WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }

function fakeQuery() {
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  let done = false
  const queue: unknown[] = []
  const stopTask = vi.fn(() => Promise.resolve())

  const query: HostedQuery = {
    interrupt: () => Promise.resolve(undefined),
    close: () => undefined,
    supportedCommands: () => Promise.resolve([]),
    supportedAgents: () => Promise.resolve([]),
    setPermissionMode: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
    supportedModels: () => Promise.resolve([]),
    stopTask,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          if (done) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
      }
    },
  } as unknown as HostedQuery

  return {
    query,
    stopTask,
    push(message: unknown) {
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: false, value: message })
      } else {
        queue.push(message)
      }
    },
    finish() {
      done = true
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: true, value: undefined })
      }
    },
  }
}

function baseParams(overrides: Partial<Parameters<typeof createHostedHandle>[0]> = {}) {
  return {
    sessionKey: SESSION_KEY,
    repoId: REPO_ID,
    workspace: WORKSPACE,
    mode: { kind: 'fresh' as const },
    cwd: '/repo',
    executablePath: '/usr/local/bin/claude',
    credentials: null,
    now: () => 1_000,
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    plugin: INSTALLED_PLUGIN,
    readExpectedComponents: () => Promise.resolve(null),
    samePath: (a: string, b: string) => a === b,
    initialTitle: null,
    defaults: DEFAULT_SESSION_DEFAULTS,
    history: { kind: 'none' as const },
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createHostedHandle — background tasks', () => {
  it('tracks a background task and reports it on the snapshot', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'sleep 120' }] })
    await flush()
    expect(handle.snapshot().backgroundTasks).toEqual([{ taskId: 't1', type: 'bash', description: 'sleep 120', toolUseId: null }])
  })

  it("stopTask refuses an id not in this handle's own tasks", async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const result = await handle.stopTask('unknown')
    expect(result).toEqual({ ok: false, kind: 'unknown-task' })
  })

  it('stopTask calls through to the SDK for a known task', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'x' }] })
    await flush()
    const result = await handle.stopTask('t1')
    expect(result).toEqual({ ok: true })
    expect(fake.stopTask).toHaveBeenCalledWith('t1')
  })

  it('resets background tasks once the session ends', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'x' }] })
    await flush()
    fake.finish()
    await flush()
    expect(handle.snapshot().backgroundTasks).toEqual([])
  })
})

describe('createHostedHandle — history', () => {
  it('returns the history passed at construction, verbatim', () => {
    const fake = fakeQuery()
    const history = { kind: 'loaded' as const, entries: [], omittedBefore: 0, sourceSessionId: 's1' }
    const handle = createHostedHandle(baseParams({ history }), () => fake.query)
    expect(handle.history()).toBe(history)
  })
})
