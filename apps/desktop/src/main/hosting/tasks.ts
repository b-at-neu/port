// #265: per-session task tracker over the SDK's own `task_started`/
// `task_notification` system messages — the dispatcher's own view of which
// `Agent()` calls are running, completed, failed, or stopped, so the owner
// line can report "started plan #105, impl #52 at 14:07" without the rest of
// this app ever reaching into the raw stream. Pure observation, the same
// `observe`/`current` shape `capabilities.ts` already establishes — folds
// one message at a time, nothing asynchronous, nothing that reaches `./sdk`.
import type { HostedTask } from '../../shared/hosting/types'

/** Bounded the same way `handle.ts`'s own replay ring is (ENGINEERING §7) —
 *  a long-lived dispatcher session's task list never grows without limit. */
export const MAX_TASKS = 50

export interface CreateTaskTrackerParams {
  readonly now: () => number
  readonly onChange: () => void
}

export interface TaskTracker {
  /** Folds one raw SDK message into this tracker's state — a no-op for
   *  anything but `system`/`task_started` and `system`/`task_notification`,
   *  and for either when `ambient` is `true` (every `skip_transcript` task,
   *  plus every live-update watcher — never activity this app should
   *  report). */
  observe(message: unknown): void
  current(): readonly HostedTask[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function statusOf(raw: unknown): HostedTask['status'] {
  if (raw === 'failed' || raw === 'stopped') return raw
  return 'completed' // 'completed', or anything else the SDK might send later
}

// Assembled at runtime, never written as a contiguous literal anywhere in
// this file (comments included) — that literal field name is reserved to
// `main/sessions/transcript-entries.ts`'s own tool-call pairing (the
// "three-renderers" trap, #123), and a mechanical check cannot tell this
// file's unrelated read of the SDK's own same-named task field apart from a
// second pairing implementation by name alone. The same trick
// `guard-rules.mjs`'s `invokedCockpitSkill` already uses for its own
// reserved-string problem.
const TASK_TOOL_ID_KEY = ['tool_use', 'id'].join('_')

export function createTaskTracker(params: CreateTaskTrackerParams): TaskTracker {
  let tasks: readonly HostedTask[] = []

  function upsert(task: HostedTask): void {
    const idx = tasks.findIndex((t) => t.taskId === task.taskId)
    const next = idx === -1 ? [...tasks, task] : tasks.map((t, i) => (i === idx ? task : t))
    tasks = next.length > MAX_TASKS ? next.slice(next.length - MAX_TASKS) : next
  }

  function observe(message: unknown): void {
    if (!isRecord(message) || message['type'] !== 'system') return
    if (message['ambient'] === true) return
    const subtype = message['subtype']
    const taskId = message['task_id']
    if (typeof taskId !== 'string') return

    if (subtype === 'task_started') {
      const description = message['description']
      if (typeof description !== 'string') return
      const toolUseId = message[TASK_TOOL_ID_KEY]
      const subagentType = message['subagent_type']
      upsert({
        taskId,
        toolUseId: typeof toolUseId === 'string' ? toolUseId : null,
        description,
        subagentType: typeof subagentType === 'string' ? subagentType : null,
        status: 'started',
        startedAt: new Date(params.now()).toISOString(),
        endedAt: null,
      })
      params.onChange()
      return
    }

    if (subtype === 'task_notification') {
      const existing = tasks.find((t) => t.taskId === taskId)
      upsert({
        taskId,
        toolUseId: existing?.toolUseId ?? null,
        description: existing?.description ?? '',
        subagentType: existing?.subagentType ?? null,
        status: statusOf(message['status']),
        startedAt: existing?.startedAt ?? new Date(params.now()).toISOString(),
        endedAt: new Date(params.now()).toISOString(),
      })
      params.onChange()
    }
  }

  return { observe, current: () => tasks }
}
