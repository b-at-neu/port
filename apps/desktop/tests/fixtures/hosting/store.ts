import { vi } from 'vitest'
import type { HostedStoreDeps } from '@/main/hosting/store'
import { createInMemoryHostingPersistence } from '@/main/hosting/persist'
import type { HostedQuery } from '@/main/hosting/handle'
import type { RepoId } from '@/utils/repos'

export const REPO_ID = 'repo-1' as RepoId

/** A never-emitting fake query — enough for tests that only care about store-level bookkeeping. */
export function idleQuery(): HostedQuery {
  return {
    interrupt: vi.fn(() => Promise.resolve({ still_queued: [] })),
    close: vi.fn(),
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) }
    },
  } as unknown as HostedQuery
}

export function endedQuery(): HostedQuery {
  return {
    interrupt: vi.fn(),
    close: vi.fn(),
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ done: true, value: undefined }) }
    },
  } as unknown as HostedQuery
}

export function baseDeps(overrides: Partial<HostedStoreDeps> = {}): HostedStoreDeps {
  return {
    getSdk: () => Promise.resolve({ query: () => idleQuery(), renameSession: vi.fn(() => Promise.resolve(undefined)) }),
    resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/usr/local/bin/claude' }),
    readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
    listSessionsForFork: () => Promise.resolve({ ok: true, sessions: [] }),
    env: {},
    platform: 'linux',
    now: () => 1_000,
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    onEntries: vi.fn(),
    resolvePluginRequest: () => Promise.resolve({ source: 'installed' }),
    readExpectedComponents: () => Promise.resolve(null),
    readStageEditAllow: () => Promise.resolve([]),
    samePath: (a: string, b: string) => a === b,
    persistence: createInMemoryHostingPersistence(),
    removeWorktree: () => Promise.resolve({ outcome: 'removed' }),
    readHistory: () => Promise.resolve({ kind: 'none' }),
    ...overrides,
  }
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
