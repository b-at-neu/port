import { describe, expect, it } from 'vitest'
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
