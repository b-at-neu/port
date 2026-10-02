import { describe, expect, it, vi } from 'vitest'
import { createTaskTracker } from './tasks'

const NOW = () => new Date('2026-01-01T00:00:00.000Z').getTime()

describe('createTaskTracker', () => {
  it('ignores anything but task_started/task_notification', () => {
    const onChange = vi.fn()
    const tracker = createTaskTracker({ now: NOW, onChange })
    tracker.observe({ type: 'system', subtype: 'init', session_id: 's1' })
    tracker.observe({ type: 'assistant', message: {} })
    expect(tracker.current()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('task_started adds a started task', () => {
    const onChange = vi.fn()
    const tracker = createTaskTracker({ now: NOW, onChange })
    tracker.observe({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', description: 'impl #52', subagent_type: 'port:impl-agent' })
    expect(tracker.current()).toEqual([
      { taskId: 't1', toolUseId: 'tu1', description: 'impl #52', subagentType: 'port:impl-agent', status: 'started', startedAt: new Date(NOW()).toISOString(), endedAt: null },
    ])
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('a matching task_notification moves the task to completed/failed/stopped, keeping its description', () => {
    const tracker = createTaskTracker({ now: NOW, onChange: () => undefined })
    tracker.observe({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'impl #52', subagent_type: 'port:impl-agent' })
    tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'failed' })
    const task = tracker.current().find((t) => t.taskId === 't1')
    expect(task?.status).toBe('failed')
    expect(task?.description).toBe('impl #52')
    expect(task?.endedAt).not.toBeNull()
  })

  it('a task_notification for a task never seen still records something, rather than throwing', () => {
    const tracker = createTaskTracker({ now: NOW, onChange: () => undefined })
    tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 'orphan', status: 'completed' })
    expect(tracker.current()).toEqual([{ taskId: 'orphan', toolUseId: null, description: '', subagentType: null, status: 'completed', startedAt: new Date(NOW()).toISOString(), endedAt: new Date(NOW()).toISOString() }])
  })

  it('ambient tasks are skipped entirely', () => {
    const onChange = vi.fn()
    const tracker = createTaskTracker({ now: NOW, onChange })
    tracker.observe({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'a watcher', ambient: true })
    expect(tracker.current()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('bounds to the newest 50 tasks', () => {
    const tracker = createTaskTracker({ now: NOW, onChange: () => undefined })
    for (let i = 0; i < 55; i++) {
      tracker.observe({ type: 'system', subtype: 'task_started', task_id: `t${String(i)}`, description: `task ${String(i)}` })
    }
    const tasks = tracker.current()
    expect(tasks.length).toBe(50)
    expect(tasks[0]?.taskId).toBe('t5')
    expect(tasks[tasks.length - 1]?.taskId).toBe('t54')
  })
})
