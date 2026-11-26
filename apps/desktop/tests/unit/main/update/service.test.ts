import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAppReleases } from '@/main/github/app-releases'
import { createUpdateService } from '@/main/features/update/service'
import type { AppRelease, FetchReleasesResult } from '@/types/update'
import { createFakeClock, createFakePlatform, fakeUpdates } from '../../../support/fake-platform'

vi.mock('@/main/github/app-releases', () => ({ fetchAppReleases: vi.fn() }))

const fetchReleases = vi.mocked(fetchAppReleases)

const release = (tag: string): AppRelease => ({ tag, notesUrl: `https://example.test/${tag}`, draft: false, prerelease: false, publishedAt: null, assets: [] })

const CLOCK = new Date('2026-03-04T05:06:07.000Z')

interface Options {
  readonly version?: string
  readonly isPackaged?: boolean
  readonly fetch?: () => Promise<FetchReleasesResult>
}

function serviceWith({ version = '1.4.0', isPackaged = true, fetch }: Options = {}) {
  fetchReleases.mockImplementation(fetch ?? (() => Promise.resolve({ ok: true, releases: [release('v1.5.0')] })))
  const platform = createFakePlatform()
  const ctx = { ...platform, clock: createFakeClock(CLOCK), info: () => ({ ...platform.info(), app: version }), updates: { ...fakeUpdates(), isPackaged } }
  return createUpdateService(ctx, { repo: 'octo/port' })
}

beforeEach(() => {
  fetchReleases.mockReset()
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
  ] as const)('never fetches for a %s build', async (_label, options, reason) => {
    const service = serviceWith({ ...options, fetch: () => Promise.reject(new Error('the network must not be touched')) })
    expect(service.state()).toMatchObject({ kind: 'disabled', reason })
    expect(await service.check('startup')).toMatchObject({ kind: 'disabled', reason })
    expect(await service.check('manual')).toMatchObject({ kind: 'disabled', reason })
    expect(fetchReleases).not.toHaveBeenCalled()
  })
})

describe('createUpdateService check', () => {
  it('starts idle and reads the configured repository', async () => {
    const service = serviceWith()
    expect(service.state()).toEqual({ kind: 'idle', current: '1.4.0' })
    await service.check('startup')
    expect(fetchReleases.mock.calls[0]?.[1]).toEqual({ owner: 'octo', name: 'port' })
  })

  it('goes through checking to available, carrying the trigger and time', async () => {
    let resolve: (result: FetchReleasesResult) => void = () => undefined
    const service = serviceWith({ fetch: () => new Promise((r) => (resolve = r)) })
    const pending = service.check('startup')
    expect(service.state()).toEqual({ kind: 'checking', current: '1.4.0', trigger: 'startup', startedAt: CLOCK.toISOString() })
    resolve({ ok: true, releases: [release('v1.5.0')] })
    const terminal = await pending
    expect(terminal).toMatchObject({ kind: 'available', current: '1.4.0', trigger: 'startup', checkedAt: CLOCK.toISOString(), release: { version: '1.5.0', tag: 'v1.5.0' } })
    expect(service.state()).toBe(terminal)
  })

  it('reports up to date for an equal or older latest release', async () => {
    const service = serviceWith({ fetch: () => Promise.resolve({ ok: true, releases: [release('v1.4.0'), release('v1.3.0')] }) })
    expect(await service.check('manual')).toMatchObject({ kind: 'up-to-date', latest: '1.4.0', trigger: 'manual' })
  })

  it('coalesces a second check into the in-flight one', async () => {
    let resolve: (result: FetchReleasesResult) => void = () => undefined
    const service = serviceWith({ fetch: () => new Promise((r) => (resolve = r)) })
    const first = service.check('startup')
    const second = service.check('manual')
    expect(second).toBe(first)
    resolve({ ok: true, releases: [] })
    await first
    expect(fetchReleases).toHaveBeenCalledTimes(1)
    const third = service.check('manual')
    expect(third).not.toBe(first)
    resolve({ ok: true, releases: [] })
    await third
    expect(fetchReleases).toHaveBeenCalledTimes(2)
  })

  it('turns a typed fetch failure into an error state and logs once', async () => {
    const service = serviceWith({ fetch: () => Promise.resolve({ ok: false, reason: 'offline', detail: 'no route' }) })
    expect(await service.check('startup')).toMatchObject({ kind: 'error', reason: 'offline', detail: 'no route', trigger: 'startup', checkedAt: CLOCK.toISOString() })
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the fetch throws or rejects', async () => {
    const throwing = serviceWith({
      fetch: () => {
        throw new Error('sync boom')
      },
    })
    expect(await throwing.check('startup')).toMatchObject({ kind: 'error', reason: 'unavailable', detail: 'sync boom' })

    const rejecting = serviceWith({ fetch: () => Promise.reject(new Error('async boom')) })
    expect(await rejecting.check('manual')).toMatchObject({ kind: 'error', reason: 'unavailable', detail: 'async boom' })
  })

  it('recovers from an error on the next check', async () => {
    let fail = true
    const service = serviceWith({ fetch: () => Promise.resolve(fail ? { ok: false, reason: 'offline', detail: 'x' } : { ok: true, releases: [release('v1.5.0')] }) })
    expect((await service.check('startup')).kind).toBe('error')
    fail = false
    expect((await service.check('manual')).kind).toBe('available')
  })
})
