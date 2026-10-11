// The background-task panel — sits between CommandStrip and Composer, rendered only when the snapshot carries at least one task.
import { useState } from 'react'
import { Bot, SquareTerminal, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { BackgroundTask } from '../../../shared/hosting/types'
import type { SessionKey } from '../../../shared/hosting/types'
import { stopTask } from './actions'
import { TASK_KEEP_RUNNING, TASK_STOP_BUTTON, TASK_STOP_TITLE, TASK_STOP_UNKNOWN, TASK_STOP_UNKNOWN_SESSION, taskStopBody, taskStopFailed } from './copy'

function TaskIcon({ type, className }: { readonly type: string; readonly className: string }) {
  if (type === 'bash') return <SquareTerminal aria-hidden="true" className={className} />
  if (type === 'agent') return <Bot aria-hidden="true" className={className} />
  return <Wrench aria-hidden="true" className={className} />
}

function TaskRow({ sessionKey, task }: { readonly sessionKey: SessionKey; readonly task: BackgroundTask }) {
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)

  async function handleStop(): Promise<void> {
    setStopping(true)
    const result = await stopTask(sessionKey, task.taskId)
    setStopping(false)
    setConfirming(false)
    if (result.ok) return
    if (result.kind === 'unknown-task') toast(TASK_STOP_UNKNOWN)
    else if (result.kind === 'unknown-session') toast(TASK_STOP_UNKNOWN_SESSION)
    else if (result.kind === 'stop-failed') toast(taskStopFailed(result.message))
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
            <Button variant="destructive" disabled={stopping} aria-busy={stopping} onClick={() => void handleStop()}>
              {stopping ? '…' : TASK_STOP_BUTTON}
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
