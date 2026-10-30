import { describe, expect, it, vi } from 'vitest'
import { createStageLauncher } from '@/main/stage/launcher'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult } from '@/types/hosting'

import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '@/main/fixtures/repos'
import type { ReadyEntry } from '@/types/actions'
import type { StartSessionParams } from '@/types/hosting'
import type { InterruptedStage, StageInstructionsLoader, StageResumeRequest } from '@/types/stage'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry

function request(overrides: Partial<StageLaunchRequest> = {}): StageLaunchRequest {
  return { entry: ENTRY, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Run your pipeline stage for #52.', title: '#52 Add a dark-mode icon for the tray', target: { kind: 'issue', title: 'Add a dark-mode icon for the tray' }, ...overrides }
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
    backgroundTasks: [],
    operatorJoinedAt: null,
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
  const createWorktree = vi.fn().mockResolvedValue({ ok: true, path: '/repo/.claude/worktrees/impl-52', branch: '52-add-a-dark-mode-icon', baseSha: 'abc', baseLabel: '52-add-a-dark-mode-icon' })
  const releaseBranch = vi.fn().mockResolvedValue('deleted')
  const sweepBranches = vi.fn().mockResolvedValue({ done: true, deleted: [] })
  const onOutcome = vi.fn()
  const registryMock = { recordRunning: vi.fn(), markRunning: vi.fn(), setSessionId: vi.fn(), markInterrupted: vi.fn(), markAllQuit: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), load: vi.fn() }
  const registry = registryMock as unknown as Parameters<typeof createStageLauncher>[0]['registry']
  const onDenial = vi.fn()
  let nextId = 0
  const newId = vi.fn(() => `id-${String((nextId += 1))}`)
  const loadInstructions = vi.fn<StageInstructionsLoader>().mockImplementation((req) => Promise.resolve({ ok: true, text: `${req.prompt}\n\n<port-stage-context>\nrepo: widgets\n</port-stage-context>\n\n<port-stage-instructions source="/plugin">\nbody\n</port-stage-instructions>` }))
  return { store, removeWorktree, createWorktree, releaseBranch, sweepBranches, onOutcome, close, dismiss, send, start, registry, registryMock, onDenial, newId, loadInstructions }
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
    expect(deps.send).toHaveBeenCalledWith('hosted-1', expect.stringContaining('Run your pipeline stage for #52.'))
  })

  it('sends the composed text, which opens with the dispatch prompt and carries both blocks', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    const sent = String(deps.send.mock.calls[0]?.[1])
    expect(sent.startsWith('Run your pipeline stage for #52.')).toBe(true)
    expect(sent).toContain('<port-stage-context>')
    expect(sent).toContain('<port-stage-instructions')
    expect(deps.loadInstructions).toHaveBeenCalledWith(expect.objectContaining({ number: 52 }), '/repo/.claude/worktrees/impl-52')
  })

  it('sends nothing, removes the worktree and fails when the instructions cannot be loaded', async () => {
    const deps = fakeDeps()
    deps.loadInstructions.mockResolvedValue({ ok: false, message: 'no port@port install record in /home/u/.claude/plugins/installed_plugins.json' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result).toEqual({ ok: false, kind: 'failed', message: "Couldn't load the stage instructions from the installed port plugin: no port@port install record in /home/u/.claude/plugins/installed_plugins.json" })
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.registryMock.recordRunning).not.toHaveBeenCalled()
    expect(deps.removeWorktree).toHaveBeenCalledWith('/repo/.claude/worktrees/impl-52', false)
    expect(deps.releaseBranch).toHaveBeenCalledWith(ENTRY.path, '52-add-a-dark-mode-icon', 'abc')
  })

  it('titles a review launch with the ticket label it was given', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request({ agent: 'review', number: 47, kind: 'pull-request', trigger: 'readyForReview', title: '#46 Show the last sync time in the header' }))
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ initialTitle: '#46 Show the last sync time in the header' }))
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
    expect(deps.removeWorktree).toHaveBeenCalledWith('/repo/.claude/worktrees/impl-52', false)
    expect(deps.releaseBranch).toHaveBeenCalledWith(ENTRY.path, '52-add-a-dark-mode-icon', 'abc')
  })

  it('does not release the branch when the worktree could not be removed', async () => {
    const deps = fakeDeps({ start: { ok: false, kind: 'not-git' } })
    deps.removeWorktree.mockResolvedValue({ outcome: 'dirty' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    expect(deps.releaseBranch).not.toHaveBeenCalled()
  })

  it('asks for a stage worktree built from the request and the configured integration branch', async () => {
    const deps = fakeDeps()
    const git = vi.fn() as never
    const launcher = createStageLauncher({ ...deps, git, now: () => new Date() })
    await launcher.launch(request())
    expect(deps.createWorktree).toHaveBeenCalledWith({ root: ENTRY.path, git, agent: 'impl', number: 52, integration: ENTRY.config.branches.integration, target: { kind: 'issue', title: 'Add a dark-mode icon for the tray' } })
  })

  it('sweeps stale session branches once per repository root, never as a gate', async () => {
    const deps = fakeDeps()
    deps.sweepBranches.mockRejectedValue(new Error('boom'))
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const first = await launcher.launch(request())
    await launcher.launch(request({ number: 53 }))
    expect(first.ok).toBe(true)
    expect(deps.sweepBranches).toHaveBeenCalledTimes(1)
    expect(deps.sweepBranches).toHaveBeenCalledWith(ENTRY.path)
  })

  it('records no branch for a detached worktree and releases nothing', async () => {
    const deps = fakeDeps({ start: { ok: false, kind: 'not-git' } })
    deps.createWorktree.mockResolvedValue({ ok: true, path: '/repo/.claude/worktrees/plan-52', branch: null, baseSha: 'abc', baseLabel: 'origin/dev' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request({ agent: 'plan', trigger: 'ready' }))
    expect(deps.removeWorktree).toHaveBeenCalled()
    expect(deps.releaseBranch).not.toHaveBeenCalled()
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

describe('createStageLauncher denials', () => {
  it('stamps the raising session on a denial from a fresh launch', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date('2026-01-01T00:00:00Z') })
    await launcher.launch(request())
    const onDeny = deps.start.mock.calls[0]?.[0].stage?.onDeny
    onDeny?.('Bash', { command: 'git push' })
    expect(deps.onDenial).toHaveBeenCalledWith(WIDGETS_ID, expect.objectContaining({ number: 52, toolName: 'Bash', sessionKey: 'hosted-1' }))
  })
})

const INTERRUPTED: InterruptedStage = {
  id: 'reg-1',
  repoId: WIDGETS_ID,
  agent: 'impl',
  number: 52,
  kind: 'issue',
  trigger: 'planApproved',
  inFlight: 'inProgress',
  model: 'sonnet',
  claudeSessionId: 'sdk-1',
  worktree: { path: '/repo/.claude/worktrees/session-abc123', branch: 'session/abc123', baseSha: 'abc' },
  startedAt: '2026-01-01T00:00:00.000Z',
  interruptedAt: '2026-01-01T00:10:00.000Z',
  reason: 'usage-limit',
  detail: null,
  resetsAt: '2026-01-01T05:00:00.000Z',
  costUsd: 1,
}

function resumeRequest(overrides: Partial<StageResumeRequest> = {}): StageResumeRequest {
  return { entry: INTERRUPTED, root: { path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] }, prompt: 'You were interrupted.', ...overrides }
}

describe('createStageLauncher.resume', () => {
  it('starts in resume mode on the kept worktree, sends the prompt, and flips the entry to running in place', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.resume(resumeRequest())
    expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
    const params = deps.start.mock.calls[0]?.[0]
    expect(params?.mode).toEqual({ kind: 'resume', sessionId: 'sdk-1' })
    expect(params?.workspace.folder).toBe('/repo/.claude/worktrees/session-abc123')
    expect(params?.stage?.agentName).toBe('port:impl-agent')
    expect(deps.createWorktree).not.toHaveBeenCalled()
    expect(deps.loadInstructions).not.toHaveBeenCalled()
    expect(deps.send).toHaveBeenCalledWith('hosted-1', 'You were interrupted.')
    expect(deps.registryMock.markRunning).toHaveBeenCalledWith('reg-1')
    expect(deps.registryMock.recordRunning).not.toHaveBeenCalled()
  })

  it('settles the same entry when the resumed session hands back', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.registryMock.remove).toHaveBeenCalledWith('reg-1')
    expect(deps.dismiss).toHaveBeenCalledWith('hosted-1', 'remove')
  })

  it('marks the same entry interrupted again when the resumed session ends abnormally', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    launcher.observe(baseSnapshot({ phase: 'ended', end: { reason: 'exit-nonzero', exitCode: 1, signal: null, message: 'boom', diagnosis: null } }))
    await vi.waitFor(() => expect(deps.registryMock.markInterrupted).toHaveBeenCalled())
    expect(deps.registryMock.markInterrupted).toHaveBeenCalledWith('reg-1', 'error', 'exit-nonzero', null, null)
  })

  it('stamps the resumed session on its denials', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    deps.start.mock.calls[0]?.[0].stage?.onDeny?.('Bash', { command: 'rm -rf x' })
    expect(deps.onDenial).toHaveBeenCalledWith(WIDGETS_ID, expect.objectContaining({ number: 52, sessionKey: 'hosted-1' }))
  })

  it('leaves the entry interrupted when the store refuses or the send fails', async () => {
    const full = fakeDeps({ start: { ok: false, kind: 'at-capacity', limit: 2 } })
    const fullLauncher = createStageLauncher({ ...full, git: vi.fn() as never, now: () => new Date() })
    expect(await fullLauncher.resume(resumeRequest())).toEqual({ ok: false, kind: 'at-capacity', limit: 2 })
    expect(full.registryMock.markRunning).not.toHaveBeenCalled()

    const deps = fakeDeps()
    deps.send.mockReturnValue({ ok: false, kind: 'blocked-command', name: 'pipeline' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.resume(resumeRequest())
    expect(result.ok).toBe(false)
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(deps.registryMock.markRunning).not.toHaveBeenCalled()
  })

  it('refuses an entry that never got a Claude session id', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.resume(resumeRequest({ entry: { ...INTERRUPTED, claudeSessionId: null } }))
    expect(result.ok).toBe(false)
    expect(deps.start).not.toHaveBeenCalled()
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
    expect(deps.releaseBranch).toHaveBeenCalledWith(ENTRY.path, '52-add-a-dark-mode-icon', 'abc')
  })

  it('on a dirty dismiss, reports kept-dirty rather than removed', async () => {
    const deps = fakeDeps()
    deps.dismiss.mockResolvedValue({ ok: false, kind: 'worktree-dirty' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ worktree: 'kept-dirty' }))
    expect(deps.releaseBranch).not.toHaveBeenCalled()
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
