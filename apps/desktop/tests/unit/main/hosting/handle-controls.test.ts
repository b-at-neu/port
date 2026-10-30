import { describe, expect, it, vi } from 'vitest'
import { createHostedHandle } from '@/main/hosting/handle'
import { baseParams, fakeQuery, flush } from '../../../fixtures/hosting/handle'

describe('setControls / answerQuestion / answerPlan', () => {
  it('setControls reports not-ready before init', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const result = await handle.setControls({ permissionMode: 'acceptEdits' })
    expect(result).toEqual({ ok: false, kind: 'not-ready' })
  })

  it('setControls applies the patch once init has reported', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' })
    await flush()
    const result = await handle.setControls({ permissionMode: 'acceptEdits' })
    expect(result).toEqual({ ok: true, controls: { permissionMode: 'acceptEdits', model: null, effort: null } })
    expect(fake.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
  })

  it('answerQuestion settles a pending AskUserQuestion call raised through options.canUseTool', async () => {
    const fake = fakeQuery()
    let capturedOptions: { canUseTool?: (toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown> } | undefined
    const handle = createHostedHandle(baseParams(), (queryParams) => {
      capturedOptions = queryParams.options as typeof capturedOptions
      return fake.query
    })
    const controller = new AbortController()
    const resultPromise = capturedOptions?.canUseTool?.('AskUserQuestion', { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }] }, { signal: controller.signal, toolUseID: 'tool-use-1' })
    const permissionId = handle.snapshot().pendingPermissions[0]?.permissionId as string

    expect(handle.answerQuestion(permissionId, { 'Which?': 'A' })).toEqual({ ok: true })
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }], answers: { 'Which?': 'A' } }, toolUseID: 'tool-use-1' })
  })

  it('a plan approved through answerPlan updates controls.permissionMode without a second SDK call', () => {
    const fake = fakeQuery()
    let capturedOptions: { canUseTool?: (toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown> } | undefined
    const handle = createHostedHandle(baseParams(), (queryParams) => {
      capturedOptions = queryParams.options as typeof capturedOptions
      return fake.query
    })
    const controller = new AbortController()
    void capturedOptions?.canUseTool?.('ExitPlanMode', { plan: 'Steps' }, { signal: controller.signal, toolUseID: 'tool-use-1' })
    const permissionId = handle.snapshot().pendingPermissions[0]?.permissionId as string

    expect(handle.answerPlan(permissionId, { kind: 'approve', mode: 'acceptEdits' })).toEqual({ ok: true })
    expect(handle.snapshot().controls.permissionMode).toBe('acceptEdits')
    expect(fake.setPermissionMode).not.toHaveBeenCalled()
  })
})

describe('a stage session pins the default permission mode at runtime', () => {
  const STAGE = { tag: { agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved' } as const, agentName: 'port:impl-agent', model: 'sonnet', sessionRequiredPaths: [], editAllow: [] }

  it('calls setPermissionMode("default") once at start', () => {
    const fake = fakeQuery()
    createHostedHandle(baseParams({ stage: STAGE }), () => fake.query)
    expect(fake.setPermissionMode).toHaveBeenCalledTimes(1)
    expect(fake.setPermissionMode).toHaveBeenCalledWith('default')
  })

  it('never calls it for an operator session', async () => {
    const fake = fakeQuery()
    createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1', permissionMode: 'acceptEdits' })
    await flush()
    expect(fake.setPermissionMode).not.toHaveBeenCalled()
  })

  it('resets and warns once when init reports another mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams({ stage: STAGE }), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1', permissionMode: 'acceptEdits' })
    await flush()
    expect(fake.setPermissionMode).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[hosting] stage session hosted-1 started in acceptEdits; reset to default')
    expect(handle.snapshot().controls.permissionMode).toBe('default')
    warn.mockRestore()
  })

  it('does not reset again when init reports the default mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeQuery()
    createHostedHandle(baseParams({ stage: STAGE }), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1', permissionMode: 'default' })
    await flush()
    expect(fake.setPermissionMode).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('logs a rejected reset instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeQuery()
    fake.setPermissionMode.mockRejectedValueOnce(new Error('refused'))
    createHostedHandle(baseParams({ stage: STAGE }), () => fake.query)
    await flush()
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
