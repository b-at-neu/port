import { vi } from 'vitest'
import type { HostedQuery, createHostedHandle } from '@/main/hosting/handle'
import { DEFAULT_SESSION_DEFAULTS } from '@/types/hosting'
import type { PluginRequest } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'
import type { SessionWorkspace } from '@/types/workspace'
import type { SessionKey } from '@/types/hosting'

export const SESSION_KEY = 'hosted-1' as SessionKey
export const REPO_ID = 'repo-1' as RepoId
export const WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }
export const INSTALLED_PLUGIN: PluginRequest = { source: 'installed' }

/** `push` delivers the next message to whichever `next()` is currently waiting. */
export function fakeQuery(options: { readonly commands?: readonly { name: string; description: string; argumentHint: string }[]; readonly agents?: readonly { name: string; description: string; model?: string }[] } = {}) {
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  let pendingReject: ((error: Error) => void) | null = null
  const queue: unknown[] = []
  let done = false
  let failure: Error | null = null

  const interrupt = vi.fn((): Promise<{ still_queued: string[] } | undefined> => Promise.resolve({ still_queued: ['a', 'b'] }))
  const close = vi.fn()
  const supportedCommands = vi.fn(() => Promise.resolve(options.commands ?? []))
  const supportedAgents = vi.fn(() => Promise.resolve(options.agents ?? []))
  const setPermissionMode = vi.fn(() => Promise.resolve())
  const setModel = vi.fn(() => Promise.resolve())
  const applyFlagSettings = vi.fn(() => Promise.resolve())
  const supportedModels = vi.fn(() => Promise.resolve([]))
  const stopTask = vi.fn(() => Promise.resolve())

  const query: HostedQuery = {
    interrupt,
    close,
    supportedCommands,
    supportedAgents,
    setPermissionMode,
    setModel,
    applyFlagSettings,
    supportedModels,
    stopTask,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          if (failure !== null) return Promise.reject(failure)
          if (done) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) => {
            pendingResolve = resolve
            pendingReject = reject
          })
        },
      }
    },
  } as unknown as HostedQuery

  return {
    query,
    interrupt,
    close,
    supportedCommands,
    supportedAgents,
    setPermissionMode,
    setModel,
    applyFlagSettings,
    supportedModels,
    stopTask,
    push(message: unknown) {
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        pendingReject = null
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
        pendingReject = null
        resolve({ done: true, value: undefined })
      }
    },
    fail(error: Error) {
      failure = error
      if (pendingReject) {
        const reject = pendingReject
        pendingResolve = null
        pendingReject = null
        reject(error)
      }
    },
  }
}

export function baseParams(overrides: Partial<Parameters<typeof createHostedHandle>[0]> = {}) {
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
    stage: null,
    ...overrides,
  }
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
