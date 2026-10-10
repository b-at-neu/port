// A pure background-task tracker — `observe` narrows level messages with REPLACE semantics, `current()` sorts by first-seen.
import { isRecord } from '../../shared/guards'
import type { BackgroundTask } from '../../shared/hosting/types'
import { TOOL_USE_ID_FIELD } from '../sessions/transcript-entries'

export interface TaskTracker {
  /** `true` when the observed message changed the current set. */
  observe(message: unknown): boolean
  current(): readonly BackgroundTask[]
  reset(): void
}

interface MutableTask {
  taskId: string
  type: string
  description: string
  toolUseId: string | null
}

function fieldsOf(raw: unknown): Record<string, unknown> | null {
  return isRecord(raw) ? raw : null
}

export function createTaskTracker(): TaskTracker {
  const seenOrder: string[] = []
  const byId = new Map<string, MutableTask>()

  function observeBackgroundTasksChanged(message: Record<string, unknown>): boolean {
    const rawTasks = message['tasks']
    if (!Array.isArray(rawTasks)) return false

    const next = new Map<string, MutableTask>()
    for (const rawTask of rawTasks) {
      const fields = fieldsOf(rawTask)
      if (fields === null) continue
      if (fields['ambient'] === true) continue
      const taskId = fields['task_id'] ?? fields['taskId']
      if (typeof taskId !== 'string' || taskId === '') continue
      const existing = byId.get(taskId)
      next.set(taskId, {
        taskId,
        type: typeof fields['type'] === 'string' ? fields['type'] : (existing?.type ?? 'task'),
        description: typeof fields['description'] === 'string' ? fields['description'] : (existing?.description ?? ''),
        toolUseId: typeof fields[TOOL_USE_ID_FIELD] === 'string' ? fields[TOOL_USE_ID_FIELD] : (existing?.toolUseId ?? null),
      })
    }

    const prevIds = new Set(byId.keys())
    const nextIds = new Set(next.keys())
    let changed = prevIds.size !== nextIds.size
    if (!changed) {
      for (const [id, task] of next) {
        const prev = byId.get(id)
        if (prev === undefined || prev.type !== task.type || prev.description !== task.description || prev.toolUseId !== task.toolUseId) {
          changed = true
          break
        }
      }
    }
    if (!changed) return false

    byId.clear()
    seenOrder.length = 0
    for (const [id, task] of next) {
      byId.set(id, task)
      seenOrder.push(id)
    }
    return true
  }

  function observeTaskStarted(message: Record<string, unknown>): boolean {
    const taskId = message['task_id'] ?? message['taskId']
    if (typeof taskId !== 'string') return false
    const existing = byId.get(taskId)
    if (existing === undefined) return false
    const toolUseId = message[TOOL_USE_ID_FIELD]
    const description = message['description']
    let changed = false
    if (typeof toolUseId === 'string' && existing.toolUseId === null) {
      existing.toolUseId = toolUseId
      changed = true
    }
    if (typeof description === 'string' && existing.description === '') {
      existing.description = description
      changed = true
    }
    return changed
  }

  return {
    observe(message) {
      if (!isRecord(message)) return false
      if (message['type'] !== 'system') return false
      if (message['subtype'] === 'background_tasks_changed') return observeBackgroundTasksChanged(message)
      if (message['subtype'] === 'task_started') return observeTaskStarted(message)
      return false
    },
    current() {
      const result: BackgroundTask[] = []
      for (const id of seenOrder) {
        const task = byId.get(id)
        if (task === undefined) continue
        result.push({ taskId: task.taskId, type: task.type, description: task.description, toolUseId: task.toolUseId })
      }
      return result
    },
    reset() {
      byId.clear()
      seenOrder.length = 0
    },
  }
}
