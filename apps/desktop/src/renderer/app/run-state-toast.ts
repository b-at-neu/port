import type { DispatchCommand, DispatchControlResult } from '@/types/dispatch'
import type { ActionToast, ToastButton } from '@/types/toast'
import type { ConfirmSpec } from '@/renderer/components/confirm-dialog'
import { haltHeadingCopy, haltItemLine } from '@/renderer/board/copy'
import { pauseAbortedCopy, pauseReportNote, runStateResultNote } from '@/renderer/board/run-state'

export const PENDING: Record<DispatchCommand, string> = {
  run: 'Starting the pipeline…',
  drain: 'Draining the pipeline…',
  pause: 'Stopping the pipeline…',
}

interface ToastContext {
  readonly name: string
  readonly undo: ToastButton | null
  readonly now: Date
}

export function runStateToast(result: DispatchControlResult, { name, undo, now }: ToastContext): ActionToast {
  const plain = { description: null, action: null, cancel: null } as const
  if (!result.ok) return { ...plain, tone: 'error', title: runStateResultNote(result) ?? `Couldn't ${result.command} ${name}.` }
  if (result.command === 'run') return { ...plain, tone: 'success', title: `${name} is running`, action: undo }
  if (result.command === 'drain') {
    const note = runStateResultNote(result)
    if (note !== null) return { ...plain, tone: 'error', title: note }
    return { ...plain, tone: 'info', title: 'Work in progress finishes; nothing new starts.', description: `${name} is draining`, action: undo }
  }
  if (result.report.kind === 'aborted') return { ...plain, tone: 'error', title: pauseAbortedCopy(result.report) }
  const lines = result.report.items.map((item) => haltItemLine(item, now))
  return { ...plain, tone: 'success', title: haltHeadingCopy(result.report, 'Stopped'), description: [pauseReportNote(result.report, name), ...lines].join(' — ') }
}

export function pauseConfirm(name: string, inFlight: number): ConfirmSpec {
  return {
    title: `Stop ${name}?`,
    description: `${inFlight} ${inFlight === 1 ? 'agent is' : 'agents are'} working on this repo. Stopping ends them and removes their in-flight labels. Nothing new starts until you run it again.`,
    confirmLabel: 'Stop pipeline',
    tone: 'destructive',
  }
}
