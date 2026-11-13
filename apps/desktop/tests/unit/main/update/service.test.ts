import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateService, type UpdateServiceDeps } from '@/main/update/service'
import type { AppRelease, FetchReleasesResult } from '@/types/update'

const release = (tag: string): AppRelease => ({ tag, notesUrl: `https://example.test/${tag}`, draft: false, prerelease: false, publishedAt: null, assets: [] })

const CLOCK = new Date('2026-03-04T05:06:07.000Z')

function serviceWith(overrides: Partial<UpdateServiceDeps> = {}) {
  const calls: { owner: string; name: string }[] = []
  const deps: UpdateServiceDeps = {
    version: '1.4.0',
    isPackaged: true,
    repo: 'octo/port',
    fetchReleases: (repo) => {
      calls.push(repo)
      return Promise.resolve({ ok: true, releases: [release('v1.5.0')] })
    },
    now: () => CLOCK,
    ...overrides,
  }
  return { service: createUpdateService(deps), calls }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createUpdateService gate', () => {
  it.each([
    ['unpackaged', { isPackaged: false }, 'unpackaged'],
    ['dev-build', { version: '1.4.0-dev' }, 'dev-build'],
    ['unparseable-version', { version: 'garbage' }, 'unparseable-version'],
  ] as const)('never fetches for a %s build', async (_label, overrides, reason) => {
    const { service, calls } = serviceWith({
      ...overrides,
      fetchReleases: () => Promise.reject(new Error('the network must not be touched')),
    })
    expect(service.state()).toMatchObject({ kind: 'disabled', reason })
    expect(await service.check('startup')).toMatchObject({ kind: 'disabled', reason })
    expect(await service.check('manual')).toMatchObject({ kind: 'disabled', reason })
    expect(calls).toHaveLength(0)
  })
})

describe('createUpdateService check', () => {
  it('starts idle and reads the configured repository', async () => {
    const { service, calls } = serviceWith()
    expect(service.state()).toEqual({ kind: 'idle', current: '1.4.0' })
    await service.check('startup')
    expect(calls).toEqual([{ owner: 'octo', name: 'port' }])
  })

  it('goes through checking to available, carrying the trigger and time', async () => {
    let resolve: (result: FetchReleasesResult) => void = () => undefined
    const { service } = serviceWith({ fetchReleases: () => new Promise((r) => (resolve = r)) })
    const pending = service.check('startup')
    expect(service.state()).toEqual({ kind: 'checking', current: '1.4.0', trigger: 'startup', startedAt: CLOCK.toISOString() })
    resolve({ ok: true, releases: [release('v1.5.0')] })
    const terminal = await pending
    expect(terminal).toMatchObject({ kind: 'available', current: '1.4.0', trigger: 'startup', checkedAt: CLOCK.toISOString(), release: { version: '1.5.0', tag: 'v1.5.0' } })
    expect(service.state()).toBe(terminal)
  })

  it('reports up to date for an equal or older latest release', async () => {
    const { service } = serviceWith({ fetchReleases: () => Promise.resolve({ ok: true, releases: [release('v1.4.0'), release('v1.3.0')] }) })
    expect(await service.check('manual')).toMatchObject({ kind: 'up-to-date', latest: '1.4.0', trigger: 'manual' })
  })

  it('coalesces a second check into the in-flight one', async () => {
    let calls = 0
    let resolve: (result: FetchReleasesResult) => void = () => undefined
    const { service } = serviceWith({
      fetchReleases: () => {
        calls++
        return new Promise((r) => (resolve = r))
      },
    })
    const first = service.check('startup')
    const second = service.check('manual')
    expect(second).toBe(first)
    resolve({ ok: true, releases: [] })
    await first
    expect(calls).toBe(1)
    const third = service.check('manual')
    expect(third).not.toBe(first)
    resolve({ ok: true, releases: [] })
    await third
    expect(calls).toBe(2)
  })

  it('turns a typed fetch failure into an error state and logs once', async () => {
    const { service } = serviceWith({ fetchReleases: () => Promise.resolve({ ok: false, reason: 'offline', detail: 'no route' }) })
    expect(await service.check('startup')).toMatchObject({ kind: 'error', reason: 'offline', detail: 'no route', trigger: 'startup', checkedAt: CLOCK.toISOString() })
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the fetch throws or rejects', async () => {
    const throwing = serviceWith({
      fetchReleases: () => {
        throw new Error('sync boom')
      },
    })
    expect(await throwing.service.check('startup')).toMatchObject({ kind: 'error', reason: 'unavailable', detail: 'sync boom' })

    const rejecting = serviceWith({ fetchReleases: () => Promise.reject(new Error('async boom')) })
    expect(await rejecting.service.check('manual')).toMatchObject({ kind: 'error', reason: 'unavailable', detail: 'async boom' })
  })

  it('recovers from an error on the next check', async () => {
    let fail = true
    const { service } = serviceWith({
      fetchReleases: () => Promise.resolve(fail ? { ok: false, reason: 'offline', detail: 'x' } : { ok: true, releases: [release('v1.5.0')] }),
    })
    expect((await service.check('startup')).kind).toBe('error')
    fail = false
    expect((await service.check('manual')).kind).toBe('available')
  })
})
