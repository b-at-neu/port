// #103: title/rateLimit/resumeTarget — split out of handle.test.ts to stay
// under the file-size limit (ENGINEERING §7). Its own minimal `fakeQuery`/
// `baseParams`, the same shapes handle.test.ts's own copies use.
import { describe, expect, it, vi } from 'vitest'
import { createHostedHandle } from './handle'
import type { HostedQuery } from './handle'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import type { PluginRequest, SessionKey } from '../../shared/hosting/types'
import type { RepoId } from '../../shared/repos'

const SESSION_KEY = 'hosted-1' as SessionKey
const REPO_ID = 'repo-1' as RepoId
const INSTALLED_PLUGIN: PluginRequest = { source: 'installed' }

function fakeQuery() {
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  const queue: unknown[] = []

  const query: HostedQuery = {
    interrupt: vi.fn(() => Promise.resolve({ still_queued: [] })),
    close: vi.fn(),
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
      }
    },
  } as unknown as HostedQuery

  return {
    query,
    push(message: unknown) {
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: false, value: message })
      } else {
        queue.push(message)
      }
    },
  }
}

function baseParams(overrides: Partial<Parameters<typeof createHostedHandle>[0]> = {}) {
  return {
    sessionKey: SESSION_KEY,
    repoId: REPO_ID,
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
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('title (#103)', () => {
  it('starts with initialTitle, and the first send() never overwrites it', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams({ initialTitle: 'Resumed title' }), () => fake.query)
    expect(handle.snapshot().title).toBe('Resumed title')
    handle.send('hello there')
    expect(handle.snapshot().title).toBe('Resumed title')
  })

  it('the first send() sets the title from the prompt when initialTitle is null', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    handle.send('fix the thing')
    expect(handle.snapshot().title).toBe('fix the thing')
    handle.send('a second message')
    expect(handle.snapshot().title).toBe('fix the thing')
  })

  it('setTitle() fills the title only while it is still null', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    handle.setTitle('Resolved later')
    expect(handle.snapshot().title).toBe('Resolved later')
    handle.setTitle('Something else')
    expect(handle.snapshot().title).toBe('Resolved later')
  })

  it('setTitle() never overrides a title send() already set', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    handle.send('fix the thing')
    handle.setTitle('Resolved later')
    expect(handle.snapshot().title).toBe('fix the thing')
  })
})

describe('rateLimit (#103)', () => {
  it('a rate_limit_event updates the snapshot and emits status', async () => {
    const onStatus = vi.fn()
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams({ onStatus }), () => fake.query)
    onStatus.mockClear()
    fake.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' } })
    await flush()
    expect(handle.snapshot().rateLimit).toMatchObject({ status: 'warning', window: 'five-hour' })
    expect(onStatus).toHaveBeenCalled()
  })

  it('an unrecognised status leaves the previous reading in place', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })
    await flush()
    fake.push({ type: 'rate_limit_event', rate_limit_info: { status: 'mystery' } })
    await flush()
    expect(handle.snapshot().rateLimit?.status).toBe('warning')
  })
})

describe('resumeTarget (#103)', () => {
  it('is null for a fresh session', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    expect(handle.resumeTarget).toBeNull()
  })

  it('is the sessionId for resume and resume-at', () => {
    const fake = fakeQuery()
    const resume = createHostedHandle(baseParams({ mode: { kind: 'resume', sessionId: 'parent-1' } }), () => fake.query)
    expect(resume.resumeTarget).toBe('parent-1')
    const resumeAt = createHostedHandle(baseParams({ mode: { kind: 'resume-at', sessionId: 'parent-2', messageUuid: 'uuid-1', resumeDropsTurn: null } }), () => fake.query)
    expect(resumeAt.resumeTarget).toBe('parent-2')
  })

  it('is null for a fork', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams({ mode: { kind: 'fork', sessionId: 'parent-1' } }), () => fake.query)
    expect(handle.resumeTarget).toBeNull()
  })
})

describe('cwd and rename (#364)', () => {
  it('exposes the cwd it was started with', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams({ cwd: '/repos/widgets' }), () => fake.query)
    expect(handle.cwd).toBe('/repos/widgets')
  })

  it('rename() sets the title unconditionally, unlike setTitle()', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams({ initialTitle: 'Original title' }), () => fake.query)
    expect(handle.snapshot().title).toBe('Original title')
    handle.setTitle('ignored — title is already set')
    expect(handle.snapshot().title).toBe('Original title')
    handle.rename('Renamed title')
    expect(handle.snapshot().title).toBe('Renamed title')
  })
})
