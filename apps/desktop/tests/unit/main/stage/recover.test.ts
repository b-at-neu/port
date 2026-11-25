import { describe, expect, it, vi } from 'vitest'
import { resumeStage, restartStage, RESUME_PROMPT } from '@/main/dispatch/stage/recover'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageLaunchResult } from '@/types/dispatch'
import type { ReleaseBranchOutcome, RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { ResolvedStageRoot, StageResumeRequest } from '@/types/stage'
import type { Run } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { memoryRuns } from '../../../support/state-store'
import { runOf, ticketOf } from '../../../support/tickets'

const REPO = 'repo1' as RepoId

const interrupted = (overrides: Partial<Run> = {}): Run =>
  runOf({
    id: 's1',
    item: { kind: 'issue', number: 300 },
    claudeSessionId: 'claude-session-1',
    worktree: { path: '/tmp/wt', branch: 'b', baseSha: 'sha' },
    costUsd: 2.5,
    endedAt: '2026-01-01T00:05:00.000Z',
    interruption: { reason: 'crash', detail: null, at: '2026-01-01T00:05:00.000Z', resetsAt: null },
    ...overrides,
  })

async function setup(overrides: Partial<Run> = {}) {
  const { runs, store: state } = memoryRuns(REPO, { tickets: [ticketOf({ repo: REPO, ticket: 300, stage: 'implement', runs: [interrupted(overrides)] })] })
  await state.ready

  const store = { list: vi.fn((): readonly HostedSessionSnapshot[] => []) }
  const resume = vi.fn((request: StageResumeRequest): Promise<StageLaunchResult> => {
    void request
    return Promise.resolve({ ok: true, sessionKey: 'hosted-1' as SessionKey })
  })
  const removeWorktree = vi.fn((): Promise<RemoveSessionWorktreeOutcome> => Promise.resolve({ outcome: 'removed' }))
  const applyRetry = vi.fn(() => Promise.resolve({ ok: true as const, outcome: { kind: 'applied' as const, argv: [] } }))
  const releaseBranch = vi.fn((): Promise<ReleaseBranchOutcome> => Promise.resolve('deleted'))
  const resolveEntry = vi.fn((): ResolvedStageRoot | null => ({ path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] }))
  const capacity = vi.fn(() => Promise.resolve({ limit: 4 }))
  return { runs, store, resume, removeWorktree, releaseBranch, applyRetry, resolveEntry, capacity }
}

describe('resumeStage', () => {
  it('hands the entry, its repository root and RESUME_PROMPT to the launcher', async () => {
    const deps = await setup()
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'ok', sessionKey: 'hosted-1' })
    expect(deps.resume).toHaveBeenCalledTimes(1)
    const request = deps.resume.mock.calls[0]?.[0]
    expect(request?.entry).toMatchObject({ id: 's1', claudeSessionId: 'claude-session-1', worktree: { path: '/tmp/wt' } })
    expect(request?.root).toEqual({ path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] })
    expect(request?.prompt).toBe(RESUME_PROMPT.replace('<n>', '300'))
  })

  it('reports at-capacity when no slot is free', async () => {
    const deps = await setup()
    deps.capacity.mockResolvedValue({ limit: 1 })
    deps.store.list.mockReturnValue([{ phase: 'streaming' } as HostedSessionSnapshot])
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'at-capacity', limit: 1 })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('maps the launcher refusing for capacity and for any other failure', async () => {
    const full = await setup()
    full.resume.mockResolvedValue({ ok: false, kind: 'at-capacity', limit: 2 })
    expect(await resumeStage(full, 's1')).toEqual({ kind: 'at-capacity', limit: 2 })

    const failed = await setup()
    failed.resume.mockResolvedValue({ ok: false, kind: 'failed', message: 'runtime problem', cause: 'resume' })
    expect(await resumeStage(failed, 's1')).toEqual({ kind: 'start-failed', message: 'runtime problem' })
  })

  it('reports start-failed when the repository is no longer configured', async () => {
    const deps = await setup()
    deps.resolveEntry.mockReturnValue(null)
    const result = await resumeStage(deps, 's1')
    expect(result).toMatchObject({ kind: 'start-failed' })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('reports no-session-id when the session died before init', async () => {
    const deps = await setup({ claudeSessionId: null })
    const result = await resumeStage(deps, 's1')
    expect(result).toEqual({ kind: 'no-session-id' })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('reports unknown-stage for an id with no interrupted run', async () => {
    const deps = await setup()
    const result = await resumeStage(deps, 'nope')
    expect(result).toEqual({ kind: 'unknown-stage' })
  })
})

describe('restartStage', () => {
  it('removes the worktree, applies retry, then clears the interruption and keeps the run as history', async () => {
    const deps = await setup()
    const result = await restartStage(deps, 's1')
    expect(result).toEqual({ kind: 'ok' })
    expect(deps.removeWorktree).toHaveBeenCalledWith('/tmp/wt', false)
    expect(deps.releaseBranch).toHaveBeenCalledWith('/repo', 'b', 'sha')
    expect(deps.applyRetry).toHaveBeenCalled()
    expect(deps.runs.list()).toHaveLength(0)
    expect(deps.runs.runsOf(REPO, 'issue', 300)).toHaveLength(1)
  })

  it('releases no branch for a detached worktree', async () => {
    const deps = await setup({ worktree: { path: '/tmp/wt', branch: null, baseSha: 'sha' } })
    const result = await restartStage(deps, 's1')
    expect(result).toEqual({ kind: 'ok' })
    expect(deps.releaseBranch).not.toHaveBeenCalled()
  })

  it('stops at a dirty worktree and applies no label', async () => {
    const deps = await setup()
    deps.removeWorktree.mockResolvedValue({ outcome: 'dirty' })
    const result = await restartStage(deps, 's1')
    expect(result).toEqual({ kind: 'worktree-dirty' })
    expect(deps.releaseBranch).not.toHaveBeenCalled()
    expect(deps.applyRetry).not.toHaveBeenCalled()
    expect(deps.runs.list()).toHaveLength(1)
  })

  it('reports unknown-stage for an id with no interrupted run', async () => {
    const deps = await setup()
    const result = await restartStage(deps, 'nope')
    expect(result).toEqual({ kind: 'unknown-stage' })
  })
})
