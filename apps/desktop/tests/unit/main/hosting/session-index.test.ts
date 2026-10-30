import { describe, expect, it, vi } from 'vitest'
import { createSessionIndex, SESSION_INDEX_CAP } from '@/main/hosting/session-index'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageTag } from '@/types/stage-session'
import type { FileResult } from '@/types/platform'

const PATH = '/data/session-index.json'
const TAG: StageTag = { agent: 'plan', number: 7, kind: 'issue', trigger: 'ready' }

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'claude-1',
    repoId: 'repo-1' as HostedSessionSnapshot['repoId'],
    workspace: { folder: '/repo/wt', root: '/repo', worktree: { path: '/repo/wt', branch: '7-x' }, base: null },
    phase: 'streaming',
    startedAt: '2026-01-01T00:10:00.000Z',
    title: 'T',
    usage: null,
    stage: null,
    operatorJoinedAt: null,
    ...overrides,
  } as HostedSessionSnapshot
}

function usage(costUsd: number): HostedSessionSnapshot['usage'] {
  return { costUsd } as HostedSessionSnapshot['usage']
}

function setup(file: FileResult<unknown> = { ok: false, kind: 'not-found', message: 'missing' }, now = '2026-01-01T01:00:00.000Z') {
  const written: unknown[] = []
  const writeJsonAtomic = vi.fn((_path: string, value: unknown) => {
    written.push(value)
    return Promise.resolve({ ok: true } as FileResult<void>)
  })
  const index = createSessionIndex({ path: PATH, readJson: <T>() => Promise.resolve(file as FileResult<T>), writeJsonAtomic, now: () => new Date(now) })
  return { index, written, writeJsonAtomic }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSessionIndex', () => {
  it('skips a snapshot with a null claudeSessionId', async () => {
    const { index, writeJsonAtomic } = setup()
    index.observe(snapshot({ claudeSessionId: null }))
    await flush()
    expect(index.list()).toEqual([])
    expect(writeJsonAtomic).not.toHaveBeenCalled()
  })

  it('records worktree branch, folder and stage, and keeps the earliest start', () => {
    const { index } = setup()
    index.observe(snapshot({ stage: TAG, startedAt: '2026-01-01T00:10:00.000Z' }))
    index.observe(snapshot({ stage: TAG, startedAt: '2026-01-01T00:20:00.000Z' }))
    expect(index.list()).toMatchObject([{ claudeSessionId: 'claude-1', cwd: '/repo/wt', branch: '7-x', stage: TAG, startedAt: '2026-01-01T00:10:00.000Z' }])
  })

  it('keeps a non-null stage when a restored snapshot has none', () => {
    const { index } = setup()
    index.observe(snapshot({ stage: TAG }))
    index.observe(snapshot({ stage: null, sessionKey: 'hosted-2' as SessionKey }))
    expect(index.list()[0]?.stage).toEqual(TAG)
  })

  it('stamps endedAt once, and clears it when the same id is live again', () => {
    let now = '2026-01-01T01:00:00.000Z'
    const index = createSessionIndex({ path: PATH, readJson: <T>() => Promise.resolve({ ok: false, kind: 'not-found', message: '' } as FileResult<T>), writeJsonAtomic: () => Promise.resolve({ ok: true } as FileResult<void>), now: () => new Date(now) })
    index.observe(snapshot({ phase: 'ended' }))
    now = '2026-01-01T02:00:00.000Z'
    index.observe(snapshot({ phase: 'ended' }))
    expect(index.list()[0]?.endedAt).toBe('2026-01-01T01:00:00.000Z')
    index.observe(snapshot({ phase: 'streaming' }))
    expect(index.list()[0]?.endedAt).toBeNull()
  })

  it('adds cost over a resumed process rather than resetting it', () => {
    const { index } = setup()
    index.observe(snapshot({ usage: usage(1) }))
    index.observe(snapshot({ usage: usage(1.5) }))
    expect(index.list()[0]?.costUsd).toBe(1.5)
    index.observe(snapshot({ sessionKey: 'hosted-2' as SessionKey, usage: usage(0.25) }))
    expect(index.list()[0]?.costUsd).toBe(1.75)
  })

  it('keeps cost null while nothing has a reading', () => {
    const { index } = setup()
    index.observe(snapshot({ usage: null }))
    expect(index.list()[0]?.costUsd).toBeNull()
  })

  it('writes nothing when an observation changes nothing', async () => {
    const { index, writeJsonAtomic } = setup()
    index.observe(snapshot())
    await flush()
    index.observe(snapshot())
    await flush()
    expect(writeJsonAtomic).toHaveBeenCalledTimes(1)
  })

  it('caps at the newest entries by start time', () => {
    const { index } = setup()
    for (let i = 0; i < SESSION_INDEX_CAP + 5; i++) {
      index.observe(snapshot({ claudeSessionId: `id-${String(i)}`, sessionKey: `k-${String(i)}` as SessionKey, startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
    }
    const list = index.list()
    expect(list).toHaveLength(SESSION_INDEX_CAP)
    expect(list.some((entry) => entry.claudeSessionId === 'id-0')).toBe(false)
    expect(list.some((entry) => entry.claudeSessionId === `id-${String(SESSION_INDEX_CAP + 4)}`)).toBe(true)
  })

  it('loads a good file, dropping only a malformed entry', async () => {
    const good = { claudeSessionId: 'a', repoId: null, cwd: '/x', branch: null, title: null, stage: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, costUsd: 1, operatorJoinedAt: null }
    const { index } = setup({ ok: true, value: { version: 1, entries: [good, { claudeSessionId: '', startedAt: 'x' }, { ...good, claudeSessionId: 'b', costUsd: 'free' }] } })
    await index.load()
    expect(index.list().map((entry) => entry.claudeSessionId)).toEqual(['a'])
  })

  it.each([
    ['a missing file', { ok: false, kind: 'not-found', message: 'missing' }],
    ['a malformed file', { ok: true, value: 'nope' }],
    ['a newer version', { ok: true, value: { version: 2, entries: [] } }],
  ])('loads empty from %s', async (_name, file) => {
    const { index } = setup(file as FileResult<unknown>)
    await index.load()
    expect(index.list()).toEqual([])
  })
})
