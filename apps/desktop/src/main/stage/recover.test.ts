import { describe, expect, it, vi } from 'vitest'
import { resumeStage, restartStage, RESUME_PROMPT } from './recover'
import { createStageRegistry } from './registry'
import type { FileResult } from '../platform/files'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult } from '../../shared/hosting/types'
import type { RemoveSessionWorktreeOutcome } from '../workspace/worktree'
import type { StartSessionParams } from '../hosting/store'
import type { InterruptedStage } from '../../shared/stage/types'
import type { RepoId } from '../../shared/repos'

function noopFs() {
  function readJson<T>(): Promise<FileResult<T>> {
    return Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
  }
  const writeJsonAtomic = vi.fn((): Promise<FileResult<void>> => Promise.resolve({ ok: true, value: undefined }))
  return { readJson, writeJsonAtomic }
}

const entry: Omit<InterruptedStage, 'reason' | 'detail' | 'resetsAt' | 'costUsd'> = {
  id: 's1',
  repoId: 'repo1' as RepoId,
  agent: 'impl',
  number: 300,
  kind: 'issue',
  trigger: 'planApproved',
  inFlight: 'inProgress',
  model: 'sonnet',
  claudeSessionId: 'claude-session-1',
  worktree: { path: '/tmp/wt', branch: 'b', baseSha: 'sha' },
  startedAt: '2026-01-01T00:00:00.000Z',
}

function setup(sessionId: string | null = 'claude-session-1') {
  const fs = noopFs()
  const registry = createStageRegistry({ path: '/tmp/stage-sessions.json', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic, now: () => new Date() })
  registry.recordRunning({ ...entry, claudeSessionId: sessionId })
  registry.markInterrupted('s1', 'crash', null, null, 2.5)

  const startResult: SessionStartResult = { ok: true, snapshot: { sessionKey: 'hosted-1' as SessionKey } as HostedSessionSnapshot }
  const store = {
    start: vi.fn((params: StartSessionParams): Promise<SessionStartResult> => {
      void params
      return Promise.resolve(startResult)
    }),
    send: vi.fn(() => ({ ok: true as const, uuid: 'u1', queued: false })),
    close: vi.fn(() => Promise.resolve({ ok: true as const })),
    list: vi.fn((): readonly HostedSessionSnapshot[] => []),
  }
  const removeWorktree = vi.fn((): Promise<RemoveSessionWorktreeOutcome> => Promise.resolve({ outcome: 'removed' }))
  const applyRetry = vi.fn(() => Promise.resolve({ ok: true as const, outcome: { kind: 'applied' as const, argv: [] } }))
  const resolveEntry = vi.fn(() => ({ path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] }))
  const capacity = vi.fn(() => Promise.resolve({ limit: 4 }))
  return { registry, store, removeWorktree, applyRetry, resolveEntry, capacity }
}

describe('resumeStage', () => {
  it('starts with mode: resume and the kept worktree, then sends RESUME_PROMPT', async () => {
    const deps = setup()
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'ok', sessionKey: 'hosted-1' })
    expect(deps.store.start).toHaveBeenCalledTimes(1)
    const call = deps.store.start.mock.calls[0]?.[0]
    expect(call?.mode).toEqual({ kind: 'resume', sessionId: 'claude-session-1' })
    expect(call?.workspace.folder).toBe('/tmp/wt')
    expect(call?.workspace.worktree).toEqual({ path: '/tmp/wt', branch: 'b' })
    expect(deps.store.send).toHaveBeenCalledWith('hosted-1', RESUME_PROMPT.replace('<n>', '300'))
  })

  it('reports at-capacity when no slot is free', async () => {
    const deps = setup()
    deps.capacity.mockResolvedValue({ limit: 1 })
    deps.store.list.mockReturnValue([{ phase: 'streaming' } as HostedSessionSnapshot])
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'at-capacity', limit: 1 })
    expect(deps.store.start).not.toHaveBeenCalled()
  })

  it('reports no-session-id when the session died before init', async () => {
    const deps = setup(null)
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'no-session-id' })
    expect(deps.store.start).not.toHaveBeenCalled()
  })

  it('reports unknown-stage for an id not in the registry', async () => {
    const deps = setup()
    const result = await resumeStage(deps, 'nope')
    expect(result).toEqual({ kind: 'unknown-stage' })
  })
})

describe('restartStage', () => {
  it('removes the worktree, then applies retry, then removes the entry', async () => {
    const deps = setup()
    const result = await restartStage(deps, 's1')
    expect(result).toEqual({ kind: 'ok' })
    expect(deps.removeWorktree).toHaveBeenCalledWith('/tmp/wt', false)
    expect(deps.applyRetry).toHaveBeenCalled()
    expect(deps.registry.list()).toHaveLength(0)
  })

  it('stops at a dirty worktree and applies no label', async () => {
    const deps = setup()
    deps.removeWorktree.mockResolvedValue({ outcome: 'dirty' })
    const result = await restartStage(deps, 's1')
    expect(result).toEqual({ kind: 'worktree-dirty' })
    expect(deps.applyRetry).not.toHaveBeenCalled()
    expect(deps.registry.list()).toHaveLength(1)
  })

  it('reports unknown-stage for an id not in the registry', async () => {
    const deps = setup()
    const result = await restartStage(deps, 'nope')
    expect(result).toEqual({ kind: 'unknown-stage' })
  })
})
