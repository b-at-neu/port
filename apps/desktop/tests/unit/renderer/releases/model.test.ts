import { describe, expect, it } from 'vitest'
import type { ReleaseQueryLike, ReleaseStatus } from '@/types/release'
import type { RepoId } from '@/utils/repos'
import { buildReleaseGroup, refetchIntervalFor, staleSinceAt } from '@/renderer/releases/model'

const REPO_ID = 'repo-1' as unknown as RepoId

const STATUS = (kind: ReleaseStatus['phase']['kind']): ReleaseStatus =>
  ({ phase: kind === 'waiting-merge' ? { kind, version: '0.3.0', releasePr: { number: 1, url: 'u' } } : { kind }, versionSource: 'tags', production: 'main', integration: 'dev', currentVersion: null, candidates: [], entries: [], truncatedNote: null, releases: [], productionHead: null, postPublishHook: null, readAt: 't' }) as ReleaseStatus

function query(overrides: Partial<ReleaseQueryLike>): ReleaseQueryLike {
  return { status: 'success', data: undefined, isError: false, errorMessage: null, dataUpdatedAt: 0, ...overrides }
}

describe('buildReleaseGroup', () => {
  it('is loading until the first read lands', () => {
    expect(buildReleaseGroup(REPO_ID, 'acme/widgets', query({ status: 'pending' })).kind).toBe('loading')
  })

  it('names a rejected invoke and a typed read failure the same way', () => {
    expect(buildReleaseGroup(REPO_ID, 'acme/widgets', query({ status: 'error', isError: true, errorMessage: 'ipc rejected' }))).toMatchObject({ kind: 'error', message: "Couldn't read releases for acme/widgets: ipc rejected" })
    expect(buildReleaseGroup(REPO_ID, 'acme/widgets', query({ data: { ok: false, message: 'gh is signed out', readAt: 't' } }))).toMatchObject({ kind: 'error', message: "Couldn't read releases for acme/widgets: gh is signed out" })
  })

  it('keeps showing the last good read behind a failed refetch', () => {
    const group = buildReleaseGroup(REPO_ID, 'acme/widgets', query({ data: { ok: true, status: STATUS('idle') }, isError: true, errorMessage: 'offline' }))
    expect(group.kind).toBe('loaded')
  })
})

describe('refetchIntervalFor', () => {
  const interval = (kind: ReleaseStatus['phase']['kind']) => refetchIntervalFor({ state: { data: { ok: true, status: STATUS(kind) } } })

  it('refetches every 60s only while waiting on a merge', () => {
    expect(interval('waiting-merge')).toBe(60_000)
    expect(interval('waiting-bump')).toBe(60_000)
    expect(interval('idle')).toBe(false)
    expect(interval('ready-to-publish')).toBe(false)
  })

  it('never polls a failed or missing read', () => {
    expect(refetchIntervalFor({ state: { data: undefined } })).toBe(false)
    expect(refetchIntervalFor({ state: { data: { ok: false, message: 'x', readAt: 't' } } })).toBe(false)
  })
})

describe('staleSinceAt', () => {
  it('is the earliest read still shown behind a failed refetch', () => {
    const good = { ok: true as const, status: STATUS('idle') }
    expect(staleSinceAt([query({ data: good, isError: true, dataUpdatedAt: 50 }), query({ data: good, isError: true, dataUpdatedAt: 20 }), query({ data: good, dataUpdatedAt: 5 })])).toBe(20)
    expect(staleSinceAt([query({ data: good })])).toBeNull()
  })
})
