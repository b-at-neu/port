import { describe, expect, it } from 'vitest'
import { createStageRegistry } from '@/main/stage/registry'
import type { FileResult } from '@/types/platform'
import type { InterruptedStage } from '@/types/stage'
import type { RepoId } from '@/utils/repos'

function fakeDeps(initial: { readonly ok: true; readonly value: unknown } | { readonly ok: false }) {
  const writes: unknown[] = []
  function readJson<T>(path: string): Promise<FileResult<T>> {
    void path
    if (!initial.ok) return Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
    return Promise.resolve({ ok: true, value: initial.value as T })
  }
  function writeJsonAtomic(path: string, value: unknown): Promise<FileResult<void>> {
    void path
    writes.push(value)
    return Promise.resolve({ ok: true, value: undefined })
  }
  return { readJson, writeJsonAtomic, writes }
}

const entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd' | 'interruptedAt'> = {
  id: 's1',
  repoId: 'repo1' as RepoId,
  agent: 'impl',
  number: 300,
  kind: 'issue',
  trigger: 'planApproved',
  inFlight: 'inProgress',
  model: 'sonnet',
  claudeSessionId: null,
  worktree: { path: '/tmp/wt', branch: 'b', baseSha: 'sha' },
  startedAt: '2026-01-01T00:00:00.000Z',
}

describe('createStageRegistry', () => {
  it('promotes a running entry found at load to crash', async () => {
    const deps = fakeDeps({ ok: true, value: { version: 1, entries: [{ ...entry, reason: 'crash', detail: null, resetsAt: null, costUsd: null, state: 'running' }] } })
    const registry = createStageRegistry({ path: '/tmp/stage-sessions.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    const loaded = await registry.load()
    expect(loaded).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.reason).toBe('crash')
  })

  it('markAllQuit marks every running entry quit', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/stage-sessions.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    registry.recordRunning(entry)
    void registry.markAllQuit()
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.reason).toBe('quit')
  })

  it('a missing or malformed file loads as empty', async () => {
    const missing = fakeDeps({ ok: false })
    const r1 = createStageRegistry({ path: '/tmp/x.json', readJson: missing.readJson, writeJsonAtomic: missing.writeJsonAtomic, now: () => new Date() })
    expect(await r1.load()).toEqual([])

    const malformed = fakeDeps({ ok: true, value: { nonsense: true } })
    const r2 = createStageRegistry({ path: '/tmp/x.json', readJson: malformed.readJson, writeJsonAtomic: malformed.writeJsonAtomic, now: () => new Date() })
    expect(await r2.load()).toEqual([])
  })

  it('a write failure keeps the in-memory state', () => {
    function readJson<T>(): Promise<FileResult<T>> {
      return Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
    }
    function writeJsonAtomic(): Promise<FileResult<void>> {
      return Promise.resolve({ ok: false, kind: 'io', message: 'disk full' })
    }
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson, writeJsonAtomic, now: () => new Date() })
    registry.recordRunning(entry)
    registry.markInterrupted('s1', 'error', 'boom', null, 1.23)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.detail).toBe('boom')
  })

  it('remove drops the entry', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    registry.recordRunning(entry)
    registry.markInterrupted('s1', 'error', null, null, null)
    registry.remove('s1')
    expect(registry.list()).toHaveLength(0)
  })

  it('recordRunning replaces an entry with the same id instead of appending a second', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    registry.recordRunning(entry)
    registry.markInterrupted('s1', 'error', null, null, null)
    registry.recordRunning({ ...entry, model: 'opus' })
    expect(registry.list()).toHaveLength(0)
    registry.markInterrupted('s1', 'error', null, null, null)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.model).toBe('opus')
  })

  it('markRunning flips an interrupted entry back in place, resetting its interruption fields', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    registry.recordRunning({ ...entry, claudeSessionId: 'c1' })
    registry.markInterrupted('s1', 'usage-limit', 'limit', '2026-01-01T05:00:00.000Z', 3)
    registry.markRunning('s1')
    expect(registry.list()).toHaveLength(0)
    void registry.markAllQuit()
    expect(registry.list()[0]).toMatchObject({ id: 's1', claudeSessionId: 'c1', reason: 'quit', detail: null, resetsAt: null, costUsd: null })
  })

  it('markRunning is a no-op for an unknown id', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    registry.recordRunning(entry)
    registry.markRunning('nope')
    void registry.markAllQuit()
    expect(registry.list()).toHaveLength(1)
  })

  it('load keeps only the newest of duplicate ids and persists the result', async () => {
    const stored = { ...entry, reason: 'crash', detail: null, resetsAt: null, costUsd: null, interruptedAt: '2026-01-01T00:00:00.000Z' }
    const deps = fakeDeps({
      ok: true,
      value: { version: 1, entries: [{ ...stored, state: 'interrupted', model: 'old' }, { ...stored, id: 's2', state: 'interrupted' }, { ...stored, state: 'running', model: 'new' }] },
    })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    const loaded = await registry.load()
    expect(loaded.map((e) => [e.id, e.model])).toEqual([
      ['s2', 'sonnet'],
      ['s1', 'new'],
    ])
    expect(deps.writes).toHaveLength(1)
  })

  it('stamps interruptedAt on markInterrupted and markAllQuit', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date('2026-02-02T02:02:02.000Z') })
    registry.recordRunning(entry)
    registry.recordRunning({ ...entry, id: 's2' })
    registry.markInterrupted('s1', 'error', null, null, null)
    void registry.markAllQuit()
    expect(registry.list().map((e) => e.interruptedAt)).toEqual(['2026-02-02T02:02:02.000Z', '2026-02-02T02:02:02.000Z'])
  })

  it('fills a missing interruptedAt at load, including on a running to crash promotion', async () => {
    const stored = { ...entry, reason: 'quit', detail: null, resetsAt: null, costUsd: null }
    const deps = fakeDeps({ ok: true, value: { version: 1, entries: [{ ...stored, state: 'interrupted' }, { ...stored, id: 's2', state: 'running' }] } })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date('2026-03-03T03:03:03.000Z') })
    const loaded = await registry.load()
    expect(loaded.map((e) => [e.id, e.reason, e.interruptedAt])).toEqual([
      ['s1', 'quit', '2026-03-03T03:03:03.000Z'],
      ['s2', 'crash', '2026-03-03T03:03:03.000Z'],
    ])
  })

  it('setSessionId attaches a claudeSessionId to a tracked entry', () => {
    const deps = fakeDeps({ ok: false })
    const registry = createStageRegistry({ path: '/tmp/x.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic, now: () => new Date() })
    registry.recordRunning(entry)
    registry.setSessionId('s1', 'claude-session-1')
    registry.markInterrupted('s1', 'crash', null, null, null)
    expect(registry.list()[0]?.claudeSessionId).toBe('claude-session-1')
  })
})
