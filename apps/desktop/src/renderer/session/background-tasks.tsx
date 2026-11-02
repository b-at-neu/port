// The background-task panel — sits between CommandStrip and Composer, rendered only when the snapshot carries at least one task.
import { useState } from 'react'
import { Bot, SquareTerminal, Wrench } from 'lucide-react'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { BackgroundTask, SessionKey, SessionTaskStopResult } from '@/types/hosting'
import type { ActionToast } from '@/types/toast'
import { runInBackground } from '@/renderer/lib/background-action'
import { stopTask } from '@/renderer/session/actions'
import { TASK_KEEP_RUNNING, TASK_STOP_BUTTON, TASK_STOP_PENDING, TASK_STOP_SUCCESS, TASK_STOP_TITLE, TASK_STOP_UNKNOWN, TASK_STOP_UNKNOWN_SESSION, taskStopBody, taskStopFailed } from '@/renderer/session/copy'

function TaskIcon({ type, className }: { readonly type: string; readonly className: string }) {
  if (type === 'bash') return <SquareTerminal aria-hidden="true" className={className} />
  if (type === 'agent') return <Bot aria-hidden="true" className={className} />
  return <Wrench aria-hidden="true" className={className} />
}

function toastFor(result: SessionTaskStopResult): ActionToast {
  const plain = { description: null, action: null, cancel: null } as const
  if (result.ok) return { ...plain, tone: 'success', title: TASK_STOP_SUCCESS }
  if (result.kind === 'unknown-task') return { ...plain, tone: 'info', title: TASK_STOP_UNKNOWN }
  if (result.kind === 'stop-failed') return { ...plain, tone: 'error', title: taskStopFailed(result.message) }
  return { ...plain, tone: 'error', title: TASK_STOP_UNKNOWN_SESSION }
}

function TaskRow({ sessionKey, task }: { readonly sessionKey: SessionKey; readonly task: BackgroundTask }) {
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)

  async function handleStop(): Promise<void> {
    setConfirming(false)
    setStopping(true)
    await runInBackground({ id: `task-stop:${sessionKey}:${task.taskId}`, pending: TASK_STOP_PENDING, run: () => stopTask(sessionKey, task.taskId), toToast: toastFor })
    setStopping(false)
  }

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
      <Button variant="ghost" size="small" disabled={stopping} onClick={() => setConfirming(true)} aria-busy={stopping}>
        Stop
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{TASK_STOP_TITLE}</AlertDialogTitle>
            <p className="text-small text-muted-foreground">{taskStopBody(task.description)}</p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {TASK_KEEP_RUNNING}
            </Button>
            <Button variant="destructive" onClick={() => void handleStop()}>
              {TASK_STOP_BUTTON}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
