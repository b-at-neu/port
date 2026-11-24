// The background-task panel — sits between CommandStrip and Composer, rendered only when the snapshot carries at least one task.
import { Bot, SquareTerminal, Wrench } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import type { BackgroundTask, SessionKey } from '@/types/hosting'
import { taskStopToast } from '@/renderer/session/outcomes'
import { TASK_KEEP_RUNNING, TASK_STOP_BUTTON, TASK_STOP_PENDING, TASK_STOP_TITLE, taskStopBody } from '@/renderer/session/copy'

function TaskIcon({ type, className }: { readonly type: string; readonly className: string }) {
  if (type === 'bash') return <SquareTerminal aria-hidden="true" className={className} />
  if (type === 'agent') return <Bot aria-hidden="true" className={className} />
  return <Wrench aria-hidden="true" className={className} />
}

function TaskRow({ sessionKey, task }: { readonly sessionKey: SessionKey; readonly task: BackgroundTask }) {
  const { request, pending, confirmDialog } = useActionMutation('session.taskStop', {
    confirm: () => ({ title: TASK_STOP_TITLE, description: taskStopBody(task.description), cancelLabel: TASK_KEEP_RUNNING, confirmLabel: TASK_STOP_BUTTON }),
    toast: { pending: TASK_STOP_PENDING, result: (result) => taskStopToast(result) },
  })

  return (
    <div className="flex h-9 items-center gap-2 text-small">
      <TaskIcon type={task.type} className="size-3.5 shrink-0 text-muted-foreground" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-1 truncate">{task.description}</span>
        </TooltipTrigger>
        <TooltipContent>{task.description}</TooltipContent>
      </Tooltip>
      <span className="shrink-0 rounded bg-muted px-1 font-mono text-meta text-muted-foreground">{task.type}</span>
      <Button variant="ghost" size="small" disabled={pending} onClick={() => request({ sessionKey, taskId: task.taskId })} aria-busy={pending}>
        Stop
      </Button>
      {confirmDialog}
    </div>
  )
}

export function BackgroundTasksPanel({ sessionKey, tasks }: { readonly sessionKey: SessionKey; readonly tasks: readonly BackgroundTask[] }) {
  if (tasks.length === 0) return null
  return (
    <div className="rounded-lg border border-border p-2">
      <span className="mb-1 block text-small font-medium">Background tasks · {tasks.length}</span>
      <div className="flex flex-col divide-y divide-border">
        {tasks.map((task) => (
          <TaskRow key={task.taskId} sessionKey={sessionKey} task={task} />
        ))}
      </div>
    </div>
  )
}
