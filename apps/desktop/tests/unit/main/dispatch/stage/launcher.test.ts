import { describe, expect, it, vi } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import { LEGACY_STAGE_SYSTEM_PROMPT } from '@/main/dispatch/stage/bundle'
import type { AppContext } from '@/main/app/context'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey, SessionStartResult, StartSessionParams } from '@/types/hosting'
import type { ReadyEntry } from '@/types/actions'
import type { InterruptedStage, StageResumeRequest } from '@/types/stage'
import type { CreateStageWorktreeResult } from '@/types/workspace'
import type { Run } from '@/utils/pipeline/ticket'
import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../../../../fixtures/app/repos'
import { createTestContext } from '../../../../support/context'
import { runOf, ticketOf } from '../../../../support/tickets'

const wt = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn(), release: vi.fn(), sweep: vi.fn(), load: vi.fn(), readPrompt: vi.fn() }))
vi.mock('@/main/repos/worktree/stage-worktree', async (original) => ({
  ...(await original<object>()),
  createStageWorktree: (_ctx: unknown, params: unknown) => wt.create(params) as unknown,
  releaseStageBranch: (_ctx: unknown, params: unknown) => wt.release(params) as unknown,
  sweepSessionBranches: (_ctx: unknown, root: unknown) => wt.sweep(root) as unknown,
}))
vi.mock('@/main/repos/worktree/worktree', async (original) => ({ ...(await original<object>()), removeSessionWorktreeAt: (_ctx: unknown, params: unknown) => wt.remove(params) as unknown }))
vi.mock('@/main/dispatch/stage/instructions', async (original) => ({ ...(await original<object>()), loadStageLaunch: (_ctx: unknown, _root: unknown, request: unknown, path: unknown) => wt.load(request, path) as unknown }))
vi.mock('@/main/sessions/hosting/stage-prompt-store', async (original) => ({ ...(await original<object>()), readStagePrompt: (_fs: unknown, _dir: unknown, id: unknown) => wt.readPrompt(id) as unknown }))

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry
const WORKTREE = '/repo/.claude/worktrees/impl-52'
const KEPT = '/repo/.claude/worktrees/session-abc123'
const AT = '2026-01-01T00:00:00.000Z'

function request(overrides: Partial<StageLaunchRequest> = {}): StageLaunchRequest {
  return { entry: ENTRY, agent: 'impl', stage: 'implement', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Run your pipeline stage for #52.', title: '#52 Add a dark-mode icon for the tray', target: { kind: 'issue', title: 'Add a dark-mode icon for the tray' }, review: null, ...overrides }
}

function baseSnapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: WIDGETS_ID,
    workspace: { folder: KEPT, root: '/repo', worktree: { path: KEPT, branch: 'session/abc123' }, base: { sha: 'abc', label: 'session/abc123' } },
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

/** An interrupted run in the kept worktree of `session-abc123`, as a previous process left it. */
function interruptedRun(id: string, overrides: Partial<Run> = {}): Run {
  return runOf({
    id,
    item: { kind: 'issue', number: 52 },
    sessionKey: null,
    claudeSessionId: 'sdk-1',
    worktree: { path: KEPT, branch: 'session/abc123', baseSha: 'abc' },
    startedAt: AT,
    endedAt: '2026-01-01T00:10:00.000Z',
    costUsd: 1,
    interruption: { reason: 'usage-limit', detail: null, at: '2026-01-01T00:10:00.000Z', resetsAt: '2026-01-01T05:00:00.000Z' },
    ...overrides,
  })
}

const CREATED: CreateStageWorktreeResult = { ok: true, path: WORKTREE, branch: '52-add-a-dark-mode-icon', baseSha: 'abc', baseLabel: '52-add-a-dark-mode-icon', reclaimed: null }

async function rig(options: { start?: SessionStartResult; runs?: readonly Run[]; agentFile?: boolean } = {}) {
  const seeded = options.runs ?? []
  const held = (number: number) => ticketOf({ repo: WIDGETS_ID, ticket: number, stage: 'implement', runs: seeded.filter((run) => run.item.number === number) })
  const start = vi.fn<(params: StartSessionParams) => Promise<SessionStartResult>>().mockResolvedValue(options.start ?? { ok: true, snapshot: baseSnapshot() })
  const close = vi.fn().mockResolvedValue({ ok: true })
  const dismiss = vi.fn().mockResolvedValue({ ok: true })
  const send = vi.fn().mockReturnValue({ ok: true, uuid: 'u1', queued: true })
  const list = vi.fn((): readonly HostedSessionSnapshot[] => [])
  const onOutcome = vi.fn()
  const onResumedTurn = vi.fn()
  const live = {
    hostedStore: { start, send, close, dismiss, list } as unknown as AppContext['live']['hostedStore'],
    dispatcher: { recordOutcome: onOutcome, recordResumedTurn: onResumedTurn } as unknown as AppContext['live']['dispatcher'],
  }
  const ctx = createTestContext({ tickets: { repoId: WIDGETS_ID, tickets: [52, 53, 60, 61, 62, 63].map(held).concat(ticketOf({ repo: WIDGETS_ID, ticket: 46, stage: 'review', pr: { number: 47, approvedAt: null } })) }, live })
  await ctx.ready
  if (options.agentFile !== false) await ctx.fs.writeText(pathOps.join('/bundle', 'agents', 'impl-agent.md'), '---\nname: impl-agent\ndescription: impl\ndisallowedTools: Agent\n---\nbody\n')
  const exists = vi.spyOn(ctx.fs, 'exists').mockResolvedValue(true)
  wt.create.mockReset().mockResolvedValue(CREATED)
  wt.remove.mockReset().mockResolvedValue({ outcome: 'removed' })
  wt.release.mockReset().mockResolvedValue('deleted')
  wt.sweep.mockReset().mockResolvedValue({ done: true, deleted: [] })
  wt.readPrompt.mockReset().mockResolvedValue(null)
  wt.load.mockReset().mockImplementation((req: StageLaunchRequest) => Promise.resolve({ ok: true, text: req.prompt, agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' }, selfContained: true } }))
  return { ctx, launcher: createStageLauncher(ctx, '/bundle'), runs: ctx.stores.runs, start, send, close, dismiss, list, onOutcome, onResumedTurn, exists }
}

type Rig = Awaited<ReturnType<typeof rig>>
const runsOf = (deps: Rig, number = 52) => deps.runs.runsOf(WIDGETS_ID, 'issue', number)
const COMPLETED = { subtype: 'success', isError: false, text: 'all done', at: 't1' }

describe('createStageLauncher.launch', () => {
  it('creates a worktree, starts a stage session, sends the prompt, and tracks the key', async () => {
    const deps = await rig()
    const result = await deps.launcher.launch(request())
    expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
    expect(deps.start).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: WIDGETS_ID,
        mode: { kind: 'fresh' },
        stage: expect.objectContaining({ agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' }, selfContained: true }, instructionsRoot: '/bundle', model: 'sonnet' }) as unknown as StartSessionParams['stage'],
      }),
    )
    expect(deps.send).toHaveBeenCalledWith('hosted-1', 'Run your pipeline stage for #52.')
    expect(wt.load).toHaveBeenCalledWith(expect.objectContaining({ number: 52 }), WORKTREE)
  })

  it('sends nothing, removes the worktree and fails when the instructions cannot be loaded', async () => {
    const deps = await rig()
    wt.load.mockResolvedValue({ ok: false, message: "couldn't read /bundle/agents/impl-agent.md: ENOENT" })
    const result = await deps.launcher.launch(request())
    expect(result).toEqual({ ok: false, kind: 'failed', message: "Couldn't load the stage instructions from the app's bundled stage prompts: couldn't read /bundle/agents/impl-agent.md: ENOENT", cause: 'instructions' })
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
    expect(runsOf(deps)).toEqual([])
    expect(wt.remove).toHaveBeenCalledWith({ path: WORKTREE, force: false })
    expect(wt.release).toHaveBeenCalledWith({ root: ENTRY.path, branch: '52-add-a-dark-mode-icon', baseSha: 'abc' })
  })

  it('titles a review launch with the ticket label it was given', async () => {
    const deps = await rig()
    await deps.launcher.launch(request({ agent: 'review', stage: 'review', number: 47, kind: 'pull-request', trigger: 'readyForReview', title: '#46 Show the last sync time in the header' }))
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ initialTitle: '#46 Show the last sync time in the header' }))
  })

  it('starts a run on the ticket, carrying the label, session and worktree', async () => {
    const deps = await rig()
    await deps.launcher.launch(request({ title: '#52 Add a dark mode icon' }))
    expect(runsOf(deps)).toMatchObject([{ title: '#52 Add a dark mode icon', sessionKey: 'hosted-1', stage: 'implement', endedAt: null, worktree: { path: WORKTREE, branch: '52-add-a-dark-mode-icon', baseSha: 'abc' } }])
  })

  it.each([[undefined, 'worktree'], [true, 'leftover-worktree']] as const)('returns failed without removing anything when the worktree itself cannot be created (leftover %s, cause %s)', async (leftover, cause) => {
    const deps = await rig()
    wt.create.mockResolvedValue({ ok: false, message: 'git worktree add failed', leftover })
    const result = await deps.launcher.launch(request())
    expect(result).toMatchObject({ ok: false, kind: 'failed', cause })
    expect(wt.remove).not.toHaveBeenCalled()
  })

  it('removes the worktree and returns at-capacity when the store refuses to start', async () => {
    const deps = await rig({ start: { ok: false, kind: 'at-capacity', limit: 3 } })
    const result = await deps.launcher.launch(request())
    expect(result).toEqual({ ok: false, kind: 'at-capacity', limit: 3 })
    expect(wt.remove).toHaveBeenCalledWith({ path: WORKTREE, force: false })
    expect(wt.release).toHaveBeenCalledWith({ root: ENTRY.path, branch: '52-add-a-dark-mode-icon', baseSha: 'abc' })
  })

  it('asks for a stage worktree built from the request and the configured integration branch', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    expect(wt.create).toHaveBeenCalledWith({ root: ENTRY.path, agent: 'impl', number: 52, integration: ENTRY.config.branches.integration, target: { kind: 'issue', title: 'Add a dark-mode icon for the tray' }, liveWorktrees: new Set() })
  })

  it('passes only open session worktrees as live — an open run whose session died never blocks the reclaim', async () => {
    const deps = await rig({ runs: [runOf({ id: 'open-9', item: { kind: 'issue', number: 60 }, worktree: { path: '/repo/.claude/worktrees/impl-9', branch: null, baseSha: 'abc' } })] })
    deps.list.mockReturnValue([
      baseSnapshot({ workspace: { folder: '/repo/.claude/worktrees/impl-8', root: '/repo', worktree: { path: '/repo/.claude/worktrees/impl-8', branch: null }, base: null } }),
      baseSnapshot({ phase: 'ended', workspace: { folder: '/repo/.claude/worktrees/impl-7', root: '/repo', worktree: { path: '/repo/.claude/worktrees/impl-7', branch: null }, base: null } }),
      baseSnapshot({ workspace: { folder: '/repo', root: '/repo', worktree: null, base: null } }),
    ])
    await deps.launcher.launch(request())
    expect(wt.create).toHaveBeenCalledWith(expect.objectContaining({ liveWorktrees: new Set(['/repo/.claude/worktrees/impl-8']) }))
  })

  describe('an interrupted run for the same ticket and agent', () => {
    const resumable = (overrides: Partial<Run> = {}) => interruptedRun('reg-1', { interruption: { reason: 'error', detail: null, at: '2026-01-01T00:10:00.000Z', resetsAt: null }, ...overrides })

    it('is resumed in its kept worktree rather than launched fresh, as the same run', async () => {
      const deps = await rig({ runs: [resumable()] })
      deps.ctx.clock.advance(6 * 3_600_000)
      const result = await deps.launcher.launch(request())
      expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
      expect(wt.create).not.toHaveBeenCalled()
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
      const deps = await rig({ runs: [resumable(overrides)] })
      deps.exists.mockResolvedValue(folderExists)
      deps.ctx.clock.advance(6 * 3_600_000)
      await deps.launcher.launch(request())
      expect(wt.create).toHaveBeenCalled()
    })
  })

  it('clears every interrupted run pointing at a reclaimed worktree and keeps the others', async () => {
    const at = (path: string, id: string, number: number) => interruptedRun(id, { item: { kind: 'issue', number }, worktree: { path, branch: null, baseSha: 'abc' } })
    const deps = await rig({ runs: [at(WORKTREE, 'old-1', 61), at(WORKTREE, 'old-2', 62), at('/repo/.claude/worktrees/impl-60', 'other', 63)] })
    wt.create.mockResolvedValue({ ...CREATED, reclaimed: WORKTREE })
    await deps.launcher.launch(request())
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['other'])
  })

  it('leaves every interrupted run alone when nothing was reclaimed', async () => {
    const deps = await rig({ runs: [interruptedRun('kept', { item: { kind: 'issue', number: 61 } })] })
    await deps.launcher.launch(request())
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['kept'])
  })

  it('sweeps stale session branches once per repository root, never as a gate', async () => {
    const deps = await rig()
    wt.sweep.mockRejectedValue(new Error('boom'))
    const first = await deps.launcher.launch(request())
    await deps.launcher.launch(request({ number: 53 }))
    expect(first.ok).toBe(true)
    expect(wt.sweep).toHaveBeenCalledTimes(1)
    expect(wt.sweep).toHaveBeenCalledWith(ENTRY.path)
  })

  it('records no branch for a detached worktree and releases nothing', async () => {
    const deps = await rig({ start: { ok: false, kind: 'not-git' } })
    wt.create.mockResolvedValue({ ...CREATED, path: '/repo/.claude/worktrees/plan-52', branch: null, baseLabel: 'origin/dev' })
    await deps.launcher.launch(request({ agent: 'plan', stage: 'plan', trigger: 'ready' }))
    expect(wt.remove).toHaveBeenCalled()
    expect(wt.release).not.toHaveBeenCalled()
  })

  it('closes the session and removes the worktree when the send itself fails', async () => {
    const deps = await rig()
    deps.send.mockReturnValue({ ok: false, kind: 'blocked-command', name: 'pipeline' })
    const result = await deps.launcher.launch(request())
    expect(result.ok).toBe(false)
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(wt.remove).toHaveBeenCalled()
  })
})

describe('createStageLauncher denials', () => {
  it('lands a denial from a fresh launch on its run', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    deps.start.mock.calls[0]?.[0].stage?.onDeny?.('Bash', { command: 'git push' })
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
  stage: 'implement',
  model: 'sonnet',
  claudeSessionId: 'sdk-1',
  worktree: { path: KEPT, branch: 'session/abc123', baseSha: 'abc' },
  startedAt: AT,
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
  const withRun = () => rig({ runs: [interruptedRun('reg-1')] })

  it('starts in resume mode on the kept worktree, sends the prompt, and opens the run again in place', async () => {
    const deps = await withRun()
    const result = await deps.launcher.resume(resumeRequest())
    expect(result).toEqual({ ok: true, sessionKey: 'hosted-1' })
    const params = deps.start.mock.calls[0]?.[0]
    expect(params?.mode).toEqual({ kind: 'resume', sessionId: 'sdk-1' })
    expect(params?.workspace.folder).toBe(KEPT)
    expect(params?.stage?.agent).toEqual({ name: 'impl-agent', definition: { description: 'impl', prompt: LEGACY_STAGE_SYSTEM_PROMPT, disallowedTools: ['Agent'] }, selfContained: false })
    expect(params?.stage?.instructionsRoot).toBe('/bundle')
    expect(wt.create).not.toHaveBeenCalled()
    expect(wt.load).not.toHaveBeenCalled()
    expect(deps.send).toHaveBeenCalledWith('hosted-1', 'You were interrupted.')
    expect(runsOf(deps)).toMatchObject([{ id: 'reg-1', sessionKey: 'hosted-1', endedAt: null, interruption: null }])
  })

  it('resumes with the saved system prompt and marks the session self-contained', async () => {
    const deps = await withRun()
    wt.readPrompt.mockResolvedValue('saved prompt')
    await deps.launcher.resume(resumeRequest())
    expect(wt.readPrompt).toHaveBeenCalledWith('sdk-1')
    expect(deps.start.mock.calls[0]?.[0].stage?.agent).toMatchObject({ definition: { prompt: 'saved prompt' }, selfContained: true })
  })

  it('reapplies the recorded ticket label as the resumed session title', async () => {
    const deps = await withRun()
    await deps.launcher.resume(resumeRequest({ entry: { ...INTERRUPTED, title: '#46 Show the last sync time in the header' } }))
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ initialTitle: '#46 Show the last sync time in the header' }))
  })

  it('falls back to the bare number when the entry recorded no title', async () => {
    const deps = await rig()
    await deps.launcher.resume(resumeRequest())
    await deps.launcher.resume(resumeRequest({ entry: { ...INTERRUPTED, number: 47, kind: 'pull-request' } }))
    expect(deps.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ initialTitle: '#52' }))
    expect(deps.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialTitle: 'PR#47' }))
  })

  it('fails the resume, naming the file, before starting when the bundled agent file is missing', async () => {
    const deps = await rig({ runs: [interruptedRun('reg-1')], agentFile: false })
    const result = await deps.launcher.resume(resumeRequest())
    expect(result).toMatchObject({ ok: false, kind: 'failed', cause: 'resume', message: expect.stringContaining(pathOps.join('/bundle', 'agents', 'impl-agent.md')) as unknown })
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['reg-1'])
  })

  it('settles the same run when the resumed session hands back', async () => {
    const deps = await withRun()
    await deps.launcher.resume(resumeRequest())
    deps.launcher.observe(baseSnapshot({ lastResult: COMPLETED }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(runsOf(deps)).toMatchObject([{ id: 'reg-1', outcome: 'completed', interruption: null }])
    expect(runsOf(deps)[0]?.endedAt).not.toBeNull()
    expect(deps.dismiss).toHaveBeenCalledWith('hosted-1', 'remove')
  })

  it('interrupts the same run again when the resumed session ends abnormally', async () => {
    const deps = await withRun()
    await deps.launcher.resume(resumeRequest())
    deps.launcher.observe(baseSnapshot({ phase: 'ended', end: { reason: 'exit-nonzero', exitCode: 1, signal: null, message: 'boom', diagnosis: null } }))
    await vi.waitFor(() => expect(deps.runs.list()).toMatchObject([{ id: 'reg-1', reason: 'error', detail: 'exit-nonzero' }]))
  })

  it('lands denials of the resumed session on the same run', async () => {
    const deps = await withRun()
    await deps.launcher.resume(resumeRequest())
    deps.start.mock.calls[0]?.[0].stage?.onDeny?.('Bash', { command: 'rm -rf x' })
    await vi.waitFor(() => expect(deps.runs.denials(WIDGETS_ID)).toMatchObject([{ number: 52, sessionKey: 'hosted-1' }]))
  })

  it('leaves the run interrupted when the store refuses or the send fails', async () => {
    const full = await rig({ start: { ok: false, kind: 'at-capacity', limit: 2 }, runs: [interruptedRun('reg-1')] })
    expect(await full.launcher.resume(resumeRequest())).toEqual({ ok: false, kind: 'at-capacity', limit: 2 })
    expect(full.runs.list().map((entry) => entry.id)).toEqual(['reg-1'])

    const deps = await withRun()
    deps.send.mockReturnValue({ ok: false, kind: 'blocked-command', name: 'pipeline' })
    const result = await deps.launcher.resume(resumeRequest())
    expect(result.ok).toBe(false)
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(deps.runs.list().map((entry) => entry.id)).toEqual(['reg-1'])
  })

  it('refuses an entry that never got a Claude session id', async () => {
    const deps = await rig()
    const result = await deps.launcher.resume(resumeRequest({ entry: { ...INTERRUPTED, claudeSessionId: null } }))
    expect(result.ok).toBe(false)
    expect(deps.start).not.toHaveBeenCalled()
  })
})

describe('createStageLauncher.observe', () => {
  it('on completed: closes, dismisses with remove, and reports the outcome untracked', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    deps.launcher.observe(baseSnapshot({ lastResult: COMPLETED }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.close).toHaveBeenCalledWith('hosted-1')
    expect(deps.dismiss).toHaveBeenCalledWith('hosted-1', 'remove')
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ kind: 'completed', worktree: 'removed' }), null)
    expect(wt.release).toHaveBeenCalledWith({ root: ENTRY.path, branch: '52-add-a-dark-mode-icon', baseSha: 'abc' })
    expect(runsOf(deps)).toMatchObject([{ outcome: 'completed', handback: null, interruption: null }])
    expect(runsOf(deps)[0]?.endedAt).not.toBeNull()
    expect(deps.runs.list()).toEqual([])
  })

  it.each([
    [{ ok: false, kind: 'worktree-dirty' }, 'it has uncommitted changes'],
    [{ ok: false, kind: 'worktree-remove-failed', message: ' locked \n' }, 'locked'],
    [{ ok: false, kind: 'unknown-session' }, 'the session could not be dismissed (unknown-session)'],
  ])('on completed with a failed dismiss %j, keeps the entry as cleanup-failed', async (dismissed, detail) => {
    const deps = await rig()
    deps.dismiss.mockResolvedValue(dismissed)
    await deps.launcher.launch(request())
    deps.launcher.observe(baseSnapshot({ lastResult: COMPLETED }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.runs.list()).toMatchObject([{ reason: 'cleanup-failed', detail }])
    expect(wt.release).not.toHaveBeenCalled()
  })

  it('on a dirty dismiss, reports kept-dirty rather than removed', async () => {
    const deps = await rig()
    deps.dismiss.mockResolvedValue({ ok: false, kind: 'worktree-dirty' })
    await deps.launcher.launch(request())
    deps.launcher.observe(baseSnapshot({ lastResult: COMPLETED }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ worktree: 'kept-dirty' }), null)
    expect(wt.release).not.toHaveBeenCalled()
  })

  it('on questions, leaves the session open and tracked, but still reports the outcome', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    deps.launcher.observe(baseSnapshot({ lastResult: { ...COMPLETED, text: 'QUESTIONS FOR HUMAN:\n- which branch?' } }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalled())
    expect(deps.close).not.toHaveBeenCalled()
    expect(deps.dismiss).not.toHaveBeenCalled()
    // A later completed result on the same session is still classified.
    deps.launcher.observe(baseSnapshot({ lastResult: { ...COMPLETED, text: 'all done now', at: 't2' } }))
    await vi.waitFor(() => expect(deps.close).toHaveBeenCalledWith('hosted-1'))
  })

  it('calls recordResumedTurn exactly once when a blocked session streams again', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    const blocked = { ...COMPLETED, text: 'BLOCKED: need a decision' }
    deps.launcher.observe(baseSnapshot({ phase: 'ready', lastResult: blocked }))
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalledTimes(1))
    expect(deps.onResumedTurn).not.toHaveBeenCalled()
    deps.launcher.observe(baseSnapshot({ phase: 'streaming', lastResult: blocked }))
    deps.launcher.observe(baseSnapshot({ phase: 'streaming', lastResult: blocked }))
    expect(deps.onResumedTurn).toHaveBeenCalledTimes(1)
    expect(deps.onResumedTurn).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1')
  })

  it('does not report a resumed turn for a session that never blocked, and ignores an untracked session key', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    deps.launcher.observe(baseSnapshot({ phase: 'ready' }))
    deps.launcher.observe(baseSnapshot({ phase: 'streaming' }))
    deps.launcher.observe(baseSnapshot({ sessionKey: 'hosted-999' as SessionKey }))
    expect(deps.onResumedTurn).not.toHaveBeenCalled()
    expect(deps.onOutcome).not.toHaveBeenCalled()
  })

  it('does not re-run the hand-back for the same lastResult.at seen twice (an observe race)', async () => {
    const deps = await rig()
    await deps.launcher.launch(request())
    const snap = baseSnapshot({ lastResult: COMPLETED })
    deps.launcher.observe(snap)
    deps.launcher.observe(snap)
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalledTimes(1))
  })
})
