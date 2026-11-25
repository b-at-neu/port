import { vi } from 'vitest'
import type { Platform } from '@/main/platform'
import type { HostedQueryFn } from '@/main/platform/sdk'
import type { HostedQuery } from '@/main/sessions/hosting/handle'
import type { HostedStoreOptions } from '@/main/sessions/hosting/store'
import { createInMemoryHostingPersistence } from '@/main/sessions/hosting/persist'
import type { RepoId } from '@/utils/repos'
import { createFakePlatform, fakeSdk, fakeWhich } from '../../support/fake-platform'

export const REPO_ID = 'repo-1' as RepoId

export type HostingCtx = Pick<Platform, 'sdk' | 'which' | 'git' | 'fs' | 'clock' | 'claudeHome' | 'paths'>

/** A never-emitting fake query — enough for tests that only care about store-level bookkeeping. */
export function idleQuery(): HostedQuery {
  return {
    interrupt: vi.fn(() => Promise.resolve({ still_queued: [] })),
    setPermissionMode: vi.fn(() => Promise.resolve()),
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

/** A fake platform whose `claude` resolves, whose query never emits and whose rename succeeds. */
export function hostingCtx(overrides: Partial<HostingCtx> = {}): HostingCtx & { readonly fs: Platform['fs'] } {
  const { git, fs, clock, claudeHome, paths } = createFakePlatform()
  return {
    sdk: fakeSdk({ query: () => idleQuery(), renameSession: () => Promise.resolve() }),
    which: fakeWhich(() => Promise.resolve({ ok: true, path: '/usr/local/bin/claude' })),
    git,
    fs,
    clock,
    claudeHome,
    paths,
    ...overrides,
  }
}

/** A platform sdk whose query is `query`, with a rename that resolves unless `renameSession` says otherwise. */
export function sdkWith(query: HostedQueryFn, renameSession: () => Promise<void> = () => Promise.resolve()): Platform['sdk'] {
  return fakeSdk({ query, renameSession })
}

export function storeOptions(overrides: Partial<HostedStoreOptions> = {}): HostedStoreOptions {
  return {
    listSessions: () => Promise.resolve({ ok: true, sessions: [] }),
    persistence: createInMemoryHostingPersistence(),
    ...overrides,
  }
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
