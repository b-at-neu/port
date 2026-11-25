import { describe, expect, it, vi } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import { STAGE_SYSTEM_PROMPT } from '@/main/dispatch/stage/bundle'
import type { FileResult } from '@/types/platform'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult } from '@/types/hosting'

import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../../../fixtures/app/repos'
import type { ReadyEntry } from '@/types/actions'
import type { StartSessionParams } from '@/types/hosting'
import type { InterruptedStage, StageInstructionsLoader, StageResumeRequest } from '@/types/stage'
import type { Run } from '@/utils/pipeline/ticket'
import { memoryRuns } from '../../../support/state-store'
import { runOf, ticketOf } from '../../../support/tickets'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry

function request(overrides: Partial<StageLaunchRequest> = {}): StageLaunchRequest {
  return { entry: ENTRY, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Run your pipeline stage for #52.', title: '#52 Add a dark-mode icon for the tray', target: { kind: 'issue', title: 'Add a dark-mode icon for the tray' }, review: null, ...overrides }
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
    capabilities: { kind: 'pending' },
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

const AT = '2026-01-01T00:00:00.000Z'

/** An interrupted run in the kept worktree of `session-abc123`, as a previous process left it. */
function interruptedRun(id: string, overrides: Partial<Run> = {}): Run {
  return runOf({
    id,
    item: { kind: 'issue', number: 52 },
    sessionKey: null,
    claudeSessionId: 'sdk-1',
    worktree: { path: '/repo/.claude/worktrees/session-abc123', branch: 'session/abc123', baseSha: 'abc' },
    startedAt: AT,
    endedAt: '2026-01-01T00:10:00.000Z',
    costUsd: 1,
    interruption: { reason: 'usage-limit', detail: null, at: '2026-01-01T00:10:00.000Z', resetsAt: '2026-01-01T05:00:00.000Z' },
    ...overrides,
  })
}

function fakeDeps(overrides: Partial<{ start: SessionStartResult; runs: readonly Run[] }> = {}) {
  const seeded = overrides.runs ?? []
  const held = (number: number) => ticketOf({ repo: WIDGETS_ID, ticket: number, stage: 'implement', runs: seeded.filter((run) => run.item.number === number) })
  const { runs, store: state } = memoryRuns(WIDGETS_ID, { at: AT, tickets: [52, 53, 60, 61, 62, 63].map(held).concat(ticketOf({ repo: WIDGETS_ID, ticket: 46, stage: 'review', pr: { number: 47, approvedAt: null } })) })
  const started = overrides.start ?? { ok: true, snapshot: baseSnapshot() }
  const close = vi.fn().mockResolvedValue({ ok: true })
  const dismiss = vi.fn().mockResolvedValue({ ok: true })
  const send = vi.fn().mockReturnValue({ ok: true, uuid: 'u1', queued: true })
  const start = vi.fn<(params: StartSessionParams) => Promise<SessionStartResult>>().mockResolvedValue(started)
  const list = vi.fn((): readonly HostedSessionSnapshot[] => [])
  const store = { start, send, close, dismiss, list } as unknown as Parameters<typeof createStageLauncher>[0]['store']
  const removeWorktree = vi.fn().mockResolvedValue({ outcome: 'removed' })
  const createWorktree = vi.fn().mockResolvedValue({ ok: true, path: '/repo/.claude/worktrees/impl-52', branch: '52-add-a-dark-mode-icon', baseSha: 'abc', baseLabel: '52-add-a-dark-mode-icon', reclaimed: null })
  const releaseBranch = vi.fn().mockResolvedValue('deleted')
  const sweepBranches = vi.fn().mockResolvedValue({ done: true, deleted: [] })
  const onOutcome = vi.fn()
  const onResumedTurn = vi.fn()
  let nextId = 0
  const newId = vi.fn(() => `id-${String((nextId += 1))}`)
  const loadInstructions = vi.fn<StageInstructionsLoader>().mockImplementation((req) =>
    Promise.resolve({
      ok: true,
      text: `${req.prompt}\n\n<port-stage-context>\nrepo: widgets\n</port-stage-context>\n\n<port-stage-instructions source="/bundle">\nbody\n</port-stage-instructions>`,
      agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' } },
    }),
  )
  const readTextFile = vi.fn((path: string) => Promise.resolve<FileResult<string>>(path === pathOps.join('/bundle', 'agents', 'impl-agent.md') ? { ok: true, value: '---\nname: impl-agent\ndescription: impl\ndisallowedTools: Agent\n---\nbody\n' } : { ok: false, kind: 'not-found', message: `ENOENT ${path}` }))
  const pathExists = vi.fn((path: string) => {
    void path
    return Promise.resolve(true)
  })
  return { ready: state.ready, store, storeList: list, removeWorktree, createWorktree, releaseBranch, sweepBranches, onOutcome, onResumedTurn, pathExists, close, dismiss, send, start, runs, newId, loadInstructions, bundleRoot: '/bundle', ops: pathOps, readTextFile }
}

const runsOf = (deps: ReturnType<typeof fakeDeps>, number = 52) => deps.runs.runsOf(WIDGETS_ID, 'issue', number)

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
        stage: expect.objectContaining({ agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' } }, instructionsRoot: '/bundle', model: 'sonnet' }) as unknown as StartSessionParams['stage'],
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
    deps.loadInstructions.mockResolvedValue({ ok: false, message: "couldn't read /bundle/agents/impl-agent.md: ENOENT" })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result).toEqual({ ok: false, kind: 'failed', message: "Couldn't load the stage instructions from the app's bundled stage prompts: couldn't read /bundle/agents/impl-agent.md: ENOENT", cause: 'instructions' })
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
    expect(runsOf(deps)).toEqual([])
    expect(deps.removeWorktree).toHaveBeenCalledWith('/repo/.claude/worktrees/impl-52', false)
    expect(deps.releaseBranch).toHaveBeenCalledWith(ENTRY.path, '52-add-a-dark-mode-icon', 'abc')
  })

  it('titles a review launch with the ticket label it was given', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request({ agent: 'review', number: 47, kind: 'pull-request', trigger: 'readyForReview', title: '#46 Show the last sync time in the header' }))
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ initialTitle: '#46 Show the last sync time in the header' }))
  })

  it('starts a run on the ticket, carrying the label, session and worktree', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request({ title: '#52 Add a dark mode icon' }))
    expect(runsOf(deps)).toMatchObject([{ id: 'id-1', title: '#52 Add a dark mode icon', sessionKey: 'hosted-1', stage: 'implement', endedAt: null, worktree: { path: '/repo/.claude/worktrees/impl-52', branch: '52-add-a-dark-mode-icon', baseSha: 'abc' } }])
  })

  it.each([[undefined, 'worktree'], [true, 'leftover-worktree']] as const)('removes the worktree and returns failed when the worktree itself cannot be created (leftover %s, cause %s)', async (leftover, cause) => {
    const deps = fakeDeps()
    deps.createWorktree.mockResolvedValue({ ok: false, message: 'git worktree add failed', leftover })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.launch(request())
    expect(result).toMatchObject({ ok: false, kind: 'failed', cause })
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

  it('asks for a stage worktree built from the request and the configured integration branch', async () => {
    const deps = fakeDeps()
    const git = vi.fn() as never
    const launcher = createStageLauncher({ ...deps, git, now: () => new Date() })
    await launcher.launch(request())
    expect(deps.createWorktree).toHaveBeenCalledWith({ root: ENTRY.path, agent: 'impl', number: 52, integration: ENTRY.config.branches.integration, target: { kind: 'issue', title: 'Add a dark-mode icon for the tray' }, liveWorktrees: new Set() })
  })

  it('passes only open session worktrees as live — an open run whose session died never blocks the reclaim', async () => {
    const deps = fakeDeps({ runs: [runOf({ id: 'open-9', item: { kind: 'issue', number: 60 }, worktree: { path: '/repo/.claude/worktrees/impl-9', branch: null, baseSha: 'abc' } })] })
    deps.storeList.mockReturnValue([
      baseSnapshot({ workspace: { folder: '/repo/.claude/worktrees/impl-8', root: '/repo', worktree: { path: '/repo/.claude/worktrees/impl-8', branch: null }, base: null } }),
      baseSnapshot({ phase: 'ended', workspace: { folder: '/repo/.claude/worktrees/impl-7', root: '/repo', worktree: { path: '/repo/.claude/worktrees/impl-7', branch: null }, base: null } }),
      baseSnapshot({ workspace: { folder: '/repo', root: '/repo', worktree: null, base: null } }),
    ])
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    expect(deps.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ liveWorktrees: new Set(['/repo/.claude/worktrees/impl-8']) }))
  })

  describe('an interrupted run for the same ticket and agent', () => {
    const resumable = (overrides: Partial<Run> = {}) => interruptedRun('reg-1', { interruption: { reason: 'error', detail: null, at: '2026-01-01T00:10:00.000Z', resetsAt: null }, ...overrides })

    it('is resumed in its kept worktree rather than launched fresh, as the same run', async () => {
      const deps = fakeDeps({ runs: [resumable()] })
      await deps.ready
      const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date('2026-01-01T06:00:00Z') })
      const result = await launcher.launch(request())
      expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
      expect(deps.createWorktree).not.toHaveBeenCalled()
      expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ mode: { kind: 'resume', sessionId: 'sdk-1' } }))
      expect(runsOf(deps)).toMatchObject([{ id: 'reg-1', sessionKey: 'hosted-1', endedAt: null, interruption: null }])
    })

    it.each([
      ['has no session id', { claudeSessionId: null }, true],
      ['is still waiting out a reset', { interruption: { reason: 'usage-limit' as const, detail: null, at: '2026-01-01T00:10:00.000Z', resetsAt: '2026-01-01T09:00:00.000Z' } }, true],
      ['belongs to another ticket', { item: { kind: 'issue' as const, number: 60 } }, true],
      ['belongs to another agent', { agent: 'plan' as const }, true],
      ['has a worktree folder that is gone', {}, false],
    ])('falls through to a fresh launch when it %s', async (_name, overrides, folderExists) => {
      const deps = fakeDeps({ runs: [resumable(overrides)] })
      await deps.ready
      deps.pathExists.mockResolvedValue(folderExists)
      const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date('2026-01-01T06:00:00Z') })
      await launcher.launch(request())
      expect(deps.createWorktree).toHaveBeenCalled()
    })

  })

  it('clears every interrupted run pointing at a reclaimed worktree and keeps the others', async () => {
    const reclaimed = '/repo/.claude/worktrees/impl-52'
    const at = (path: string, id: string, number: number) => interruptedRun(id, { item: { kind: 'issue', number }, worktree: { path, branch: null, baseSha: 'abc' } })
    const deps = fakeDeps({ runs: [at(reclaimed, 'old-1', 61), at(reclaimed, 'old-2', 62), at('/repo/.claude/worktrees/impl-60', 'other', 63)] })
    deps.createWorktree.mockResolvedValue({ ok: true, path: reclaimed, branch: '52-add-a-dark-mode-icon', baseSha: 'abc', baseLabel: '52-add-a-dark-mode-icon', reclaimed })
    await deps.ready
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['other'])
  })

  it('leaves every interrupted run alone when nothing was reclaimed', async () => {
    const deps = fakeDeps({ runs: [interruptedRun('kept', { item: { kind: 'issue', number: 61 } })] })
    await deps.ready
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['kept'])
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
    deps.createWorktree.mockResolvedValue({ ok: true, path: '/repo/.claude/worktrees/plan-52', branch: null, baseSha: 'abc', baseLabel: 'origin/dev', reclaimed: null })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request({ agent: 'plan', trigger: 'ready' }))
    expect(deps.removeWorktree).toHaveBeenCalled()
    expect(deps.releaseBranch).not.toHaveBeenCalled()
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
  it('lands a denial from a fresh launch on its run', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date('2026-01-01T00:00:00Z') })
    await launcher.launch(request())
    const onDeny = deps.start.mock.calls[0]?.[0].stage?.onDeny
    onDeny?.('Bash', { command: 'git push' })
    await vi.waitFor(() => expect(deps.runs.denials(WIDGETS_ID)).toMatchObject([{ number: 52, toolName: 'Bash', sessionKey: 'hosted-1' }]))
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
  networkRetries: 0,
}

function resumeRequest(overrides: Partial<StageResumeRequest> = {}): StageResumeRequest {
  return { entry: INTERRUPTED, root: { path: '/repo', sessionRequiredPaths: ['CLAUDE.md'] }, prompt: 'You were interrupted.', ...overrides }
}

describe('createStageLauncher.resume', () => {
  const withRun = () => fakeDeps({ runs: [interruptedRun('reg-1')] })

  it('starts in resume mode on the kept worktree, sends the prompt, and opens the run again in place', async () => {
    const deps = withRun()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.resume(resumeRequest())
    expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
    const params = deps.start.mock.calls[0]?.[0]
    expect(params?.mode).toEqual({ kind: 'resume', sessionId: 'sdk-1' })
    expect(params?.workspace.folder).toBe('/repo/.claude/worktrees/session-abc123')
    expect(params?.stage?.agent).toEqual({ name: 'impl-agent', definition: { description: 'impl', prompt: STAGE_SYSTEM_PROMPT, disallowedTools: ['Agent'] } })
    expect(params?.stage?.instructionsRoot).toBe('/bundle')
    expect(deps.createWorktree).not.toHaveBeenCalled()
    expect(deps.loadInstructions).not.toHaveBeenCalled()
    expect(deps.send).toHaveBeenCalledWith('hosted-1', 'You were interrupted.')
    expect(runsOf(deps)).toMatchObject([{ id: 'reg-1', sessionKey: 'hosted-1', endedAt: null, interruption: null }])
  })

  it('reapplies the recorded ticket label as the resumed session title', async () => {
    const deps = withRun()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest({ entry: { ...INTERRUPTED, title: '#46 Show the last sync time in the header' } }))
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ initialTitle: '#46 Show the last sync time in the header' }))
  })

  it('falls back to the bare number when the entry recorded no title', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    await launcher.resume(resumeRequest({ entry: { ...INTERRUPTED, number: 47, kind: 'pull-request' } }))
    expect(deps.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ initialTitle: '#52' }))
    expect(deps.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialTitle: 'PR#47' }))
  })

  it('fails the resume, naming the file, before starting when the bundled agent file is missing', async () => {
    const deps = withRun()
    deps.readTextFile.mockResolvedValue({ ok: false, kind: 'not-found', message: 'ENOENT' })
    await deps.ready
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.resume(resumeRequest())
    expect(result).toEqual({ ok: false, kind: 'failed', message: `couldn't read ${pathOps.join('/bundle', 'agents', 'impl-agent.md')}: ENOENT`, cause: 'resume' })
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['reg-1'])
  })

  it('settles the same run when the resumed session hands back', async () => {
    const deps = withRun()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(runsOf(deps)).toMatchObject([{ id: 'reg-1', outcome: 'completed', interruption: null }])
    expect(runsOf(deps)[0]?.endedAt).not.toBeNull()
    expect(deps.dismiss).toHaveBeenCalledWith('hosted-1', 'remove')
  })

  it('interrupts the same run again when the resumed session ends abnormally', async () => {
    const deps = withRun()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    launcher.observe(baseSnapshot({ phase: 'ended', end: { reason: 'exit-nonzero', exitCode: 1, signal: null, message: 'boom', diagnosis: null } }))
    await vi.waitFor(() => expect(deps.runs.list()).toMatchObject([{ id: 'reg-1', reason: 'error', detail: 'exit-nonzero' }]))
  })

  it('lands denials of the resumed session on the same run', async () => {
    const deps = withRun()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.resume(resumeRequest())
    deps.start.mock.calls[0]?.[0].stage?.onDeny?.('Bash', { command: 'rm -rf x' })
    await vi.waitFor(() => expect(deps.runs.denials(WIDGETS_ID)).toMatchObject([{ number: 52, sessionKey: 'hosted-1' }]))
  })

  it('leaves the run interrupted when the store refuses or the send fails', async () => {
    const full = fakeDeps({ start: { ok: false, kind: 'at-capacity', limit: 2 }, runs: [interruptedRun('reg-1')] })
    const fullLauncher = createStageLauncher({ ...full, git: vi.fn() as never, now: () => new Date() })
    expect(await fullLauncher.resume(resumeRequest())).toEqual({ ok: false, kind: 'at-capacity', limit: 2 })
    expect(full.runs.list().map((entry) => entry.id)).toEqual(['reg-1'])

    const deps = withRun()
    deps.send.mockReturnValue({ ok: false, kind: 'blocked-command', name: 'pipeline' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    const result = await launcher.resume(resumeRequest())
    expect(result.ok).toBe(false)
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['reg-1'])
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
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ kind: 'completed', worktree: 'removed' }), null)
    expect(deps.releaseBranch).toHaveBeenCalledWith(ENTRY.path, '52-add-a-dark-mode-icon', 'abc')
    expect(runsOf(deps)).toMatchObject([{ id: 'id-1', outcome: 'completed', handback: null, interruption: null }])
    expect(runsOf(deps)[0]?.endedAt).not.toBeNull()
    expect(deps.runs.list()).toEqual([])
  })

  it.each([
    [{ ok: false, kind: 'worktree-dirty' }, 'it has uncommitted changes'],
    [{ ok: false, kind: 'worktree-remove-failed', message: ' locked \n' }, 'locked'],
    [{ ok: false, kind: 'unknown-session' }, 'the session could not be dismissed (unknown-session)'],
  ])('on completed with a failed dismiss %j, keeps the entry as cleanup-failed', async (dismissed, detail) => {
    const deps = fakeDeps()
    deps.dismiss.mockResolvedValue(dismissed)
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.runs.list()).toMatchObject([{ id: 'id-1', reason: 'cleanup-failed', detail }])
    expect(deps.releaseBranch).not.toHaveBeenCalled()
  })

  it('on a dirty dismiss, reports kept-dirty rather than removed', async () => {
    const deps = fakeDeps()
    deps.dismiss.mockResolvedValue({ ok: false, kind: 'worktree-dirty' })
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ lastResult: { subtype: 'success', isError: false, text: 'all done', at: 't1' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ worktree: 'kept-dirty' }), null)
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

  it('calls onResumedTurn exactly once when a blocked session streams again', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    const blocked = { subtype: 'success', isError: false, text: 'BLOCKED: need a decision', at: 't1' }
    launcher.observe(baseSnapshot({ phase: 'ready', lastResult: blocked }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalledTimes(1))
    expect(deps.onResumedTurn).not.toHaveBeenCalled()
    launcher.observe(baseSnapshot({ phase: 'streaming', lastResult: blocked }))
    launcher.observe(baseSnapshot({ phase: 'streaming', lastResult: blocked }))
    expect(deps.onResumedTurn).toHaveBeenCalledTimes(1)
    expect(deps.onResumedTurn).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1')
  })

  it('does not call onResumedTurn for a session that never blocked, and ignores an untracked session key', async () => {
    const deps = fakeDeps()
    const launcher = createStageLauncher({ ...deps, git: vi.fn() as never, now: () => new Date() })
    await launcher.launch(request())
    launcher.observe(baseSnapshot({ phase: 'ready' }))
    launcher.observe(baseSnapshot({ phase: 'streaming' }))
    launcher.observe(baseSnapshot({ sessionKey: 'hosted-999' as SessionKey }))
    expect(deps.onResumedTurn).not.toHaveBeenCalled()
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
