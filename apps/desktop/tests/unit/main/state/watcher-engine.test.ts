import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { StateEngine } from '@/types/offload'
import { createInProcessEngine } from '@/main/offload/engine'
import { createPipelineWatcher } from '@/main/state/watcher'
import { fakeGit, makeFakeTimer, readyEntry } from '../../../fixtures/watcher-harness'

const now = () => new Date('2026-01-01T00:00:00.000Z')

describe('createPipelineWatcher — engine injection', () => {
  it('reads every source and the projection through the injected engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
    const inner = createInProcessEngine({ now, git: fakeGit({ worktreeList: 0 }), sessionReader: () => Promise.resolve({ ok: true, sessions: [] }) })
    const calls: string[] = []
    const engine: StateEngine = {
      ...inner,
      refreshSessions: (params) => (calls.push('refreshSessions'), inner.refreshSessions(params)),
      project: (params) => (calls.push('project'), inner.project(params)),
    }
    const watcher = createPipelineWatcher({ repositories: [readyEntry('repo-a', root, 'o/a')], onSnapshot: () => undefined, now, setTimer: makeFakeTimer().factory, engine })
    await watcher.refresh()
    watcher.stop()
    expect(calls).toEqual(['refreshSessions', 'project'])
  })

  it('a failed projection keeps the previous snapshot, fires nothing, and still reschedules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
    const inner = createInProcessEngine({ now, git: fakeGit({ worktreeList: 0 }), sessionReader: () => Promise.resolve({ ok: true, sessions: [] }) })
    let failing = false
    const engine: StateEngine = { ...inner, project: (params) => (failing ? Promise.reject(new Error('worker stopped')) : inner.project(params)) }
    const onSnapshot = vi.fn()
    const timer = makeFakeTimer()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const watcher = createPipelineWatcher({ repositories: [readyEntry('repo-a', root, 'o/a')], onSnapshot, now, setTimer: timer.factory, engine })

    const good = await watcher.refresh()
    onSnapshot.mockClear()
    failing = true
    const kept = await watcher.refresh()
    watcher.stop()

    expect(kept).toBe(good)
    expect(watcher.snapshot().emittedAt).toBe(good.emittedAt)
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('[watcher] projection failed', expect.any(Error))
    error.mockRestore()
  })
})
