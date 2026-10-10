import { describe, expect, it, vi } from 'vitest'
import { createStageLauncher } from './launcher'
import type { StageLaunchRequest } from '../dispatch/launch'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult } from '../../shared/hosting/types'
import type { StartSessionParams } from '../hosting/store'
import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../fixtures/repos'
import type { ReadyEntry } from '../actions/apply'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry

function request(overrides: Partial<StageLaunchRequest> = {}): StageLaunchRequest {
  return { entry: ENTRY, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Run your pipeline stage for #52.', ...overrides }
}

function baseSnapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: WIDGETS_ID,
    workspace: { folder: '/repo/.claude/worktrees/session-abc123', root: '/repo', worktree: { path: '/repo/.claude/worktrees/session-abc123', branch: 'session/abc123' }, base: { sha: 'abc', label: 'session/abc123' } },
    phase: 'streaming',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: null,
    rateLimit: null,
    controls: { permissionMode: 'default', model: null, effort: null },
    models: { kind: 'pending' },
    usage: null,
    stage: { agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved' },
    lastResult: null,
    ...overrides,
  }
}

function fakeDeps(overrides: Partial<{ start: SessionStartResult }> = {}) {
  const started = overrides.start ?? { ok: true, snapshot: baseSnapshot() }
  const close = vi.fn().mockResolvedValue({ ok: true })
  const dismiss = vi.fn().mockResolvedValue({ ok: true })
  const send = vi.fn().mockReturnValue({ ok: true, uuid: 'u1', queued: true })
  const start = vi.fn<(params: StartSessionParams) => Promise<SessionStartResult>>().mockResolvedValue(started)
  const store = { start, send, close, dismiss } as unknown as Parameters<typeof createStageLauncher>[0]['store']
  const removeWorktree = vi.fn().mockResolvedValue({ outcome: 'removed' })
  const createWorktree = vi.fn().mockResolvedValue({ ok: true, path: '/repo/.claude/worktrees/session-abc123', branch: 'session/abc123', baseSha: 'abc' })
  const onOutcome = vi.fn()
  return { store, removeWorktree, createWorktree, onOutcome, close, dismiss, send, start }
}

describe('createStageLauncher.launch', () => {
  it('creates a worktree, starts a stage session, sends the prompt, and tracks the key', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date('2026-01-01T00:00:00Z') })
    const result = await launcher.launch(request())
    expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
    expect(deps.start).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: WIDGETS_ID,
        mode: { kind: 'fresh' },
        stage: expect.objectContaining({ agentName: 'port:impl-agent', model: 'sonnet' }) as unknown as StartSessionParams['stage'],
      }),
    )
    expect(deps.send).toHaveBeenCalledWith('hosted-1', 'Run your pipeline stage for #52.')
  })

  it('removes the worktree and returns failed when the worktree itself cannot be created', async () => {
    const deps = fakeDeps()
    deps.createWorktree.mockResolvedValue({ ok: false, message: 'git worktree add failed' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result.ok).toBe(false)
    expect(deps.removeWorktree).not.toHaveBeenCalled()
  })

  it('removes the worktree and returns at-capacity when the store refuses to start', async () => {
    const deps = fakeDeps({ start: { ok: false, kind: 'at-capacity', limit: 3 } })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result).toEqual({ ok: false, kind: 'at-capacity', limit: 3 })
    expect(deps.removeWorktree).toHaveBeenCalledWith('/repo/.claude/worktrees/session-abc123', false)
  })

  it('removes the worktree and returns failed on any other start failure', async () => {
    const deps = fakeDeps({ start: { ok: false, kind: 'not-git' } })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result.ok).toBe(false)
    expect(deps.removeWorktree).toHaveBeenCalled()
  })

  it('closes the session and removes the worktree when the send itself fails', async () => {
    const deps = fakeDeps()
    deps.send.mockReturnValue({ ok: false, kind: 'blocked-command', name: 'pipeline' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result.ok).toBe(false)
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(deps.removeWorktree).toHaveBeenCalled()
  })
})

describe('createStageLauncher.observe', () => {
  it('on completed: closes, dismisses with remove, and reports the outcome untracked', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(deps.dismiss).toHaveBeenCalledWith('hosted-1', 'remove')
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ kind: 'completed', worktree: 'removed' }))
  })

  it('on a dirty dismiss, reports kept-dirty rather than removed', async () => {
    const deps = fakeDeps()
    deps.dismiss.mockResolvedValue({ ok: false, kind: 'worktree-dirty' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ worktree: 'kept-dirty' }))
  })

  it('on questions, leaves the session open and tracked, but still reports the outcome', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'QUESTIONS FOR HUMAN:\n- which branch?', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.close).not.toHaveBeenCalled()
    expect(deps.dismiss).not.toHaveBeenCalled()
    // A later completed result on the same session is still classified.
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done now', at: 't2' } }))
    await vi.waitFor(() => expect(deps.close).toHaveBeenCalledWith('hosted-1'))
  })

  it('ignores a snapshot for an untracked session key', () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    expect(() => launcher.observe(baseSnapshot({ sessionKey: 'hosted-999' as SessionKey }))).not.toThrow()
    expect(deps.onOutcome).not.toHaveBeenCalled()
  })

  it('does not re-run the hand-back for the same lastResult.at seen twice (an observe race)', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    const snap = baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } })
    launcher.observe(snap)
    launcher.observe(snap)
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalledTimes(1))
  })
})
