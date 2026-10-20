import { describe, expect, it, vi } from 'vitest'
import { resumeStage, restartStage, RESUME_PROMPT } from '@/main/stage/recover'
import { createStageRegistry } from '@/main/stage/registry'
import type { FileResult } from '@/types/platform'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageLaunchResult } from '@/types/dispatch'
import type { RemoveSessionWorktreeOutcome } from '@/types/workspace'

import type { InterruptedStage, ResolvedStageRoot, StageResumeRequest } from '@/types/stage'
import type { RepoId } from '@/utils/repos'

function noopFs() {
  function readJson<T>(): Promise<FileResult<T>> {
    return Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
  }
  const writeJsonAtomic = vi.fn((): Promise<FileResult<void>> => Promise.resolve({ ok: true, value: undefined }))
  return { readJson, writeJsonAtomic }
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
  claudeSessionId: 'claude-session-1',
  worktree: { path: '/tmp/wt', branch: 'b', baseSha: 'sha' },
  startedAt: '2026-01-01T00:00:00.000Z',
}

function setup(sessionId: string | null = 'claude-session-1') {
  const fs = noopFs()
  const registry = createStageRegistry({ path: '/tmp/stage-sessions.json', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic, now: () => new Date() })
  registry.recordRunning({ ...entry, claudeSessionId: sessionId })
  registry.markInterrupted('s1', 'crash', null, null, 2.5)

  const store = { list: vi.fn((): readonly HostedSessionSnapshot[] => []) }
  const resume = vi.fn((request: StageResumeRequest): Promise<StageLaunchResult> => {
    void request
    return Promise.resolve({ ok: true, sessionKey: 'hosted-1' as SessionKey })
  })
  const removeWorktree = vi.fn((): Promise<RemoveSessionWorktreeOutcome> => Promise.resolve({ outcome: 'removed' }))
  const applyRetry = vi.fn(() => Promise.resolve({ ok: true as const, outcome: { kind: 'applied' as const, argv: [] } }))
  const resolveEntry = vi.fn((): ResolvedStageRoot | null => ({ path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] }))
  const capacity = vi.fn(() => Promise.resolve({ limit: 4 }))
  return { registry, store, resume, removeWorktree, applyRetry, resolveEntry, capacity }
}

describe('resumeStage', () => {
  it('hands the entry, its repository root and RESUME_PROMPT to the launcher', async () => {
    const deps = setup()
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'ok', sessionKey: 'hosted-1' })
    expect(deps.resume).toHaveBeenCalledTimes(1)
    const request = deps.resume.mock.calls[0]?.[0]
    expect(request?.entry).toMatchObject({ id: 's1', claudeSessionId: 'claude-session-1', worktree: { path: '/tmp/wt' } })
    expect(request?.root).toEqual({ path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] })
    expect(request?.prompt).toBe(RESUME_PROMPT.replace('<n>', '300'))
  })

  it('never adds a second registry entry itself', async () => {
    const deps = setup()
    await resumeStage(deps, 's1')
    expect(deps.registry.list()).toHaveLength(1)
    expect(deps.registry.list()[0]?.id).toBe('s1')
  })

  it('reports at-capacity when no slot is free', async () => {
    const deps = setup()
    deps.capacity.mockResolvedValue({ limit: 1 })
    deps.store.list.mockReturnValue([{ phase: 'streaming' } as HostedSessionSnapshot])
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'at-capacity', limit: 1 })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('maps the launcher refusing for capacity and for any other failure', async () => {
    const full = setup()
    full.resume.mockResolvedValue({ ok: false, kind: 'at-capacity', limit: 2 })
    expect(await resumeStage(full, 's1')).toEqual({ kind: 'at-capacity', limit: 2 })

    const failed = setup()
    failed.resume.mockResolvedValue({ ok: false, kind: 'failed', message: 'runtime problem' })
    expect(await resumeStage(failed, 's1')).toEqual({ kind: 'start-failed', message: 'runtime problem' })
  })

  it('reports start-failed when the repository is no longer configured', async () => {
    const deps = setup()
    deps.resolveEntry.mockReturnValue(null)
    const result = await resumeStage(deps, 's1')
    expect(result).toMatchObject({ kind: 'start-failed' })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('reports no-session-id when the session died before init', async () => {
    const deps = setup(null)
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'no-session-id' })
    expect(deps.resume).not.toHaveBeenCalled()
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
