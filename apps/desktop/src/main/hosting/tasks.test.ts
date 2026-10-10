import { describe, expect, it } from 'vitest'
import { createTaskTracker } from './tasks'

function changed(taskId: string, type: string, description: string) {
  return { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: taskId, type, description }] }
}

describe('createTaskTracker', () => {
  it('reports no tasks until observed', () => {
    expect(createTaskTracker().current()).toEqual([])
  })

  it('observes a background_tasks_changed message with REPLACE semantics', () => {
    const tracker = createTaskTracker()
    expect(tracker.observe(changed('t1', 'bash', 'sleep 120'))).toBe(true)
    expect(tracker.current()).toEqual([{ taskId: 't1', type: 'bash', description: 'sleep 120', toolUseId: null }])

    expect(tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toBe(true)
    expect(tracker.current()).toEqual([])
  })

  it('excludes ambient tasks', () => {
    const tracker = createTaskTracker()
    tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', type: 'bash', description: 'x', ambient: true }] })
    expect(tracker.current()).toEqual([])
  })

  it('returns false for an observation that changes nothing', () => {
    const tracker = createTaskTracker()
    tracker.observe(changed('t1', 'bash', 'sleep 120'))
    expect(tracker.observe(changed('t1', 'bash', 'sleep 120'))).toBe(false)
  })

  it('fills in toolUseId/description from task_started only for an already-held task', () => {
    const tracker = createTaskTracker()
    expect(tracker.observe({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1' })).toBe(false)

    tracker.observe(changed('t1', 'bash', ''))
    expect(tracker.observe({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', description: 'sleep 120' })).toBe(true)
    expect(tracker.current()).toEqual([{ taskId: 't1', type: 'bash', description: 'sleep 120', toolUseId: 'tu1' }])
  })

  it('sorts current() by first-seen', () => {
    const tracker = createTaskTracker()
    tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't2', type: 'bash', description: 'b' }] })
    tracker.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 't2', type: 'bash', description: 'b' },
        { task_id: 't1', type: 'bash', description: 'a' },
      ],
    })
    expect(tracker.current().map((task) => task.taskId)).toEqual(['t2', 't1'])
  })

  it('reset() clears everything', () => {
    const tracker = createTaskTracker()
    tracker.observe(changed('t1', 'bash', 'x'))
    tracker.reset()
    expect(tracker.current()).toEqual([])
  })
})
