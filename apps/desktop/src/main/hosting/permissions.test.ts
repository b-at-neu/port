import { describe, expect, it, vi } from 'vitest'
import { createPermissionBroker, DEFAULT_DENY_MESSAGE } from './permissions'
import type { PermissionUpdate } from './sdk'

function baseOptions(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    toolUseID: 'tool-use-1',
    ...overrides,
  } as never
}

describe('createPermissionBroker', () => {
  it('canUseTool adds a pending request and calls onChange', () => {
    const onChange = vi.fn()
    const broker = createPermissionBroker({ now: () => 1_000, onChange })
    void broker.canUseTool('Bash', { command: 'touch x' }, baseOptions())
    expect(onChange).toHaveBeenCalledTimes(1)
    const pending = broker.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.toolName).toBe('Bash')
    expect(pending[0]?.input).toEqual({ command: 'touch x' })
    expect(pending[0]?.requestedAt).toBe(new Date(1_000).toISOString())
  })

  it('never puts the SDK requestId or toolUseID on the pending contract', () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    void broker.canUseTool('Bash', {}, baseOptions({ requestId: 'req-1', toolUseID: 'tool-use-1' }))
    const pending = broker.pending()[0] as unknown as Record<string, unknown>
    expect(pending['requestId']).toBeUndefined()
    expect(pending['toolUseID']).toBeUndefined()
  })

  it('optional fields default to null when the SDK omits them', () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    void broker.canUseTool('Bash', {}, baseOptions())
    const pending = broker.pending()[0]
    expect(pending?.title).toBeNull()
    expect(pending?.displayName).toBeNull()
    expect(pending?.description).toBeNull()
    expect(pending?.decisionReason).toBeNull()
    expect(pending?.blockedPath).toBeNull()
    expect(pending?.agentId).toBeNull()
    expect(pending?.sessionGrant).toBeNull()
  })

  it('an already-aborted signal resolves deny at once and adds nothing', async () => {
    const onChange = vi.fn()
    const broker = createPermissionBroker({ now: () => 1_000, onChange })
    const controller = new AbortController()
    controller.abort()
    const result = await broker.canUseTool('Bash', {}, { signal: controller.signal, toolUseID: 'tool-use-1' } as never)
    expect(result).toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: 'tool-use-1' })
    expect(broker.pending()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('aborting mid-flight removes the entry, resolves deny, and calls onChange', async () => {
    const onChange = vi.fn()
    const broker = createPermissionBroker({ now: () => 1_000, onChange })
    const controller = new AbortController()
    const promise = broker.canUseTool('Bash', {}, { signal: controller.signal, toolUseID: 'tool-use-1' } as never)
    expect(broker.pending()).toHaveLength(1)
    controller.abort()
    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: 'tool-use-1' })
    expect(broker.pending()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2) // once on add, once on the abort settle
  })

  it('answer("allow-once") resolves allow with the original input, and removes the entry', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const promise = broker.canUseTool('Write', { file_path: 'x.txt' }, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    const outcome = broker.answer(permissionId, 'allow-once', null)
    expect(outcome).toEqual({ ok: true })
    const result = await promise
    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: 'x.txt' }, toolUseID: 'tool-use-1' })
    expect(broker.pending()).toEqual([])
  })

  it('answer("deny") resolves deny with the given message, defaulting when null', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const promise = broker.canUseTool('Bash', {}, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    broker.answer(permissionId, 'deny', 'no thanks')
    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: 'no thanks', toolUseID: 'tool-use-1' })
  })

  it('answer("deny") with a null message uses DEFAULT_DENY_MESSAGE', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const promise = broker.canUseTool('Bash', {}, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    broker.answer(permissionId, 'deny', null)
    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: 'tool-use-1' })
  })

  it('answer("allow-session") carries the narrowed grant when one exists', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' }]
    const promise = broker.canUseTool('Bash', { command: 'touch x' }, baseOptions({ suggestions }))
    const request = broker.pending()[0]
    expect(request?.sessionGrant).toEqual([{ kind: 'rule', toolName: 'Bash', ruleContent: 'touch:*' }])
    const outcome = broker.answer(request?.permissionId as string, 'allow-session', null)
    expect(outcome).toEqual({ ok: true })
    const result = await promise
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'touch x' },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'session' }],
      toolUseID: 'tool-use-1',
    })
  })

  it('answer("allow-session") returns no-session-grant and settles nothing when there is no grant', () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    void broker.canUseTool('Bash', {}, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    const outcome = broker.answer(permissionId, 'allow-session', null)
    expect(outcome).toEqual({ ok: false, kind: 'no-session-grant' })
    expect(broker.pending()).toHaveLength(1)
  })

  it('answer on an unknown id returns unknown-permission', () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    expect(broker.answer('nonexistent', 'deny', null)).toEqual({ ok: false, kind: 'unknown-permission' })
  })

  it('a second answer on the same id is refused, never applied twice', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const promise = broker.canUseTool('Bash', {}, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    expect(broker.answer(permissionId, 'allow-once', null)).toEqual({ ok: true })
    expect(broker.answer(permissionId, 'deny', null)).toEqual({ ok: false, kind: 'unknown-permission' })
    const result = await promise
    if (result === null) throw new Error('unreachable — this broker never resolves null')
    expect(result.behavior).toBe('allow')
  })

  it('pending() is sorted oldest first', () => {
    let clock = 1_000
    const broker = createPermissionBroker({ now: () => clock, onChange: vi.fn() })
    void broker.canUseTool('Bash', {}, baseOptions())
    clock = 2_000
    void broker.canUseTool('Write', {}, baseOptions())
    const pending = broker.pending()
    expect(pending.map((p) => p.toolName)).toEqual(['Bash', 'Write'])
  })

  it('narrows an AskUserQuestion call into a question interaction', () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    void broker.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }] }, baseOptions())
    expect(broker.pending()[0]?.interaction).toEqual({ kind: 'question', questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: null }] }] })
  })

  it('answer() refuses an allow decision on an interaction entry with interaction-prompt, but deny still works', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const promise = broker.canUseTool('ExitPlanMode', { plan: 'Do the thing' }, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    expect(broker.answer(permissionId, 'allow-once', null)).toEqual({ ok: false, kind: 'interaction-prompt' })
    expect(broker.pending()).toHaveLength(1)
    expect(broker.answer(permissionId, 'deny', null)).toEqual({ ok: true })
    await expect(promise).resolves.toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: 'tool-use-1' })
  })

  it('answerQuestion settles allow with the merged answers, refusing a non-question entry and a mismatched answer set', async () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    const promise = broker.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }] }, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string

    expect(broker.answerQuestion(permissionId, { Other: 'x' })).toEqual({ ok: false, kind: 'answers-mismatch' })
    expect(broker.answerQuestion(permissionId, { 'Which?': 'A' })).toEqual({ ok: true })
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }], answers: { 'Which?': 'A' } }, toolUseID: 'tool-use-1' })

    const second = broker.canUseTool('Bash', {}, baseOptions())
    const secondId = broker.pending()[0]?.permissionId as string
    expect(broker.answerQuestion(secondId, { x: 'y' })).toEqual({ ok: false, kind: 'not-a-question' })
    void second
  })

  it('answerPlan approve pins the mode and fires onPlanApproved; keep-planning denies with the feedback', async () => {
    const onPlanApproved = vi.fn()
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn(), onPlanApproved })
    const promise = broker.canUseTool('ExitPlanMode', { plan: 'Steps' }, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    expect(broker.answerPlan(permissionId, { kind: 'approve', mode: 'acceptEdits' })).toEqual({ ok: true })
    expect(onPlanApproved).toHaveBeenCalledWith('acceptEdits')
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'Steps' }, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], toolUseID: 'tool-use-1' })

    const second = broker.canUseTool('ExitPlanMode', { plan: 'More' }, baseOptions())
    const secondId = broker.pending()[0]?.permissionId as string
    expect(broker.answerPlan(secondId, { kind: 'keep-planning', feedback: 'Add tests' })).toEqual({ ok: true })
    await expect(second).resolves.toEqual({ behavior: 'deny', message: 'Add tests', toolUseID: 'tool-use-1' })
  })

  it('answerPlan refuses not-a-plan for a non-plan entry', () => {
    const broker = createPermissionBroker({ now: () => 1_000, onChange: vi.fn() })
    void broker.canUseTool('Bash', {}, baseOptions())
    const permissionId = broker.pending()[0]?.permissionId as string
    expect(broker.answerPlan(permissionId, { kind: 'keep-planning', feedback: 'x' })).toEqual({ ok: false, kind: 'not-a-plan' })
  })

  it('cancelAll settles every pending request as deny and empties the list', async () => {
    const onChange = vi.fn()
    const broker = createPermissionBroker({ now: () => 1_000, onChange })
    const first = broker.canUseTool('Bash', {}, baseOptions())
    const second = broker.canUseTool('Write', {}, baseOptions())
    expect(broker.pending()).toHaveLength(2)
    broker.cancelAll()
    expect(broker.pending()).toEqual([])
    await expect(first).resolves.toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: 'tool-use-1' })
    await expect(second).resolves.toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: 'tool-use-1' })
  })
})
