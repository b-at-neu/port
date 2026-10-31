import { describe, expect, it } from 'vitest'
import { createHostedHandle } from '@/main/hosting/handle'
import { baseParams, fakeQuery, flush } from '../../../fixtures/hosting/handle'

describe('createHostedHandle — background tasks', () => {
  it('tracks a background task and reports it on the snapshot', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'sleep 120' }] })
    await flush()
    expect(handle.snapshot().backgroundTasks).toEqual([{ taskId: 't1', type: 'bash', description: 'sleep 120', toolUseId: null }])
  })

  it("stopTask refuses an id not in this handle's own tasks", async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const result = await handle.stopTask('unknown')
    expect(result).toEqual({ ok: false, kind: 'unknown-task' })
  })

  it('stopTask calls through to the SDK for a known task', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'x' }] })
    await flush()
    const result = await handle.stopTask('t1')
    expect(result).toEqual({ ok: true })
    expect(fake.stopTask).toHaveBeenCalledWith('t1')
  })

  it('resets background tasks once the session ends', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'x' }] })
    await flush()
    fake.finish()
    await flush()
    expect(handle.snapshot().backgroundTasks).toEqual([])
  })
})

describe('createHostedHandle — history', () => {
  it('returns the history passed at construction, verbatim', () => {
    const fake = fakeQuery()
    const history = { kind: 'loaded' as const, entries: [], omittedBefore: 0, sourceSessionId: 's1' }
    const handle = createHostedHandle(baseParams({ history }), () => fake.query)
    expect(handle.history()).toBe(history)
  })
})
