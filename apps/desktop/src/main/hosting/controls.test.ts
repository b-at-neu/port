import { describe, expect, it, vi } from 'vitest'
import { createControlsTracker } from './controls'
import type { HostedQuery } from './sdk'

function fakeQuery(overrides: Partial<HostedQuery> = {}): HostedQuery {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
    interrupt: () => Promise.resolve(undefined),
    close: () => undefined,
    supportedCommands: () => Promise.resolve([]),
    supportedAgents: () => Promise.resolve([]),
    setPermissionMode: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
    supportedModels: () =>
      Promise.resolve([
        { value: 'opus', displayName: 'Opus', description: 'Most capable', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
        { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
      ]),
    ...overrides,
  }
}

describe('createControlsTracker', () => {
  it('starts from the operator defaults with a null effort', () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: 'sonnet' }, onChange: () => undefined })
    expect(tracker.current()).toEqual({ permissionMode: 'default', model: 'sonnet', effort: null })
    expect(tracker.models()).toEqual({ kind: 'pending' })
  })

  it('reads supportedModels back on start', async () => {
    const onChange = vi.fn()
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange })
    await tracker.start(fakeQuery())
    expect(tracker.models()).toEqual({
      kind: 'ready',
      models: [
        { value: 'opus', displayName: 'Opus', description: 'Most capable', efforts: ['low', 'high'] },
        { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced', efforts: [] },
      ],
    })
    expect(onChange).toHaveBeenCalled()
  })

  it('goes unavailable on a rejected supportedModels call, never an empty ready list', async () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    await tracker.start(fakeQuery({ supportedModels: () => Promise.reject(new Error('boom')) }))
    expect(tracker.models()).toEqual({ kind: 'unavailable', message: 'boom' })
  })

  it('goes unavailable on a timeout', async () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined, timeoutMs: 1 })
    await tracker.start(fakeQuery({ supportedModels: () => new Promise(() => undefined) }))
    expect(tracker.models().kind).toBe('unavailable')
  })

  it('adopts permissionMode/model from init, once', () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    tracker.observe({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits', model: 'opus' })
    expect(tracker.current()).toEqual({ permissionMode: 'acceptEdits', model: 'opus', effort: null })
    tracker.observe({ type: 'system', subtype: 'init', permissionMode: 'plan', model: 'sonnet' })
    expect(tracker.current().permissionMode).toBe('acceptEdits')
  })

  it('set() applies each changed field and updates the snapshot only after every call resolves', async () => {
    const calls: string[] = []
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    await tracker.start(fakeQuery())
    const result = await tracker.set(
      fakeQuery({
        setPermissionMode: () => {
          calls.push('mode')
          return Promise.resolve()
        },
        setModel: () => {
          calls.push('model')
          return Promise.resolve()
        },
        applyFlagSettings: () => {
          calls.push('effort')
          return Promise.resolve()
        },
      }),
      { permissionMode: 'acceptEdits', model: 'opus', effort: 'high' },
    )
    expect(calls).toEqual(['mode', 'model', 'effort'])
    expect(result).toEqual({ ok: true, controls: { permissionMode: 'acceptEdits', model: 'opus', effort: 'high' } })
  })

  it('refuses a model not in the current ready list', async () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    await tracker.start(fakeQuery())
    const result = await tracker.set(fakeQuery(), { model: 'haiku' })
    expect(result).toEqual({ ok: false, kind: 'unknown-model' })
  })

  it('refuses an effort the chosen model does not list', async () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    await tracker.start(fakeQuery())
    const result = await tracker.set(fakeQuery(), { model: 'sonnet', effort: 'high' })
    expect(result).toEqual({ ok: false, kind: 'unsupported-effort' })
  })

  it('clears an effort the new model does not support, rather than refusing the model change', async () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    await tracker.start(fakeQuery())
    await tracker.set(fakeQuery(), { model: 'opus', effort: 'high' })
    const result = await tracker.set(fakeQuery(), { model: 'sonnet' })
    expect(result).toEqual({ ok: true, controls: { permissionMode: 'default', model: 'sonnet', effort: null } })
  })

  it('a rejected SDK call reports rejected and keeps the last confirmed value', async () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    const result = await tracker.set(fakeQuery({ setPermissionMode: () => Promise.reject(new Error('refused')) }), { permissionMode: 'plan' })
    expect(result).toEqual({ ok: false, kind: 'rejected', message: 'refused' })
    expect(tracker.current().permissionMode).toBe('default')
  })

  it('adoptApprovedMode updates permissionMode without an SDK call', () => {
    const tracker = createControlsTracker({ defaults: { permissionMode: 'default', model: null }, onChange: () => undefined })
    tracker.adoptApprovedMode('acceptEdits')
    expect(tracker.current().permissionMode).toBe('acceptEdits')
  })
})
