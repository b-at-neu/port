import { toast } from 'sonner'
import type { ActionToast } from '@/types/toast'

export const FRESH ={ action: undefined, cancel: undefined, duration: undefined } as const

export const UNREACHABLE: ActionToast ={ tone: 'error', title: "Couldn't reach the main process. Restart port to try again.", description: null, action: null, cancel: null }

export function showActionToast(id: string, result: ActionToast): void {
  const options = {
    ...FRESH,
    id,
    description: result.description ?? undefined,
    ...(result.action === null ? {} : { action: { label: result.action.label, onClick: result.action.onClick } }),
    ...(result.cancel === null ? {} : { cancel: { label: result.cancel.label, onClick: result.cancel.onClick } }),
  }
  if (result.tone === 'success') toast.success(result.title, options)
  else if (result.tone === 'info') toast.info(result.title, options)
  else toast.error(result.title, options)
}

interface BackgroundAction<T> {
  readonly id: string
  readonly pending: string
  readonly run: () => Promise<T>
  readonly toToast: (result: T) => ActionToast | null
  readonly unreachable?: ActionToast
}

export async function runInBackground<T>(action: BackgroundAction<T>): Promise<T | 'unreachable'> {
  const { id, pending, run, toToast, unreachable = UNREACHABLE } = action
  toast.loading(pending, { ...FRESH, id, description: undefined })
  let result: T
  try {
    result = await run()
  } catch (error) {
    console.error(`Failed to reach the main process for ${id}`, error)
    showActionToast(id, unreachable)
    return 'unreachable'
  }
  const next = toToast(result)
  if (next === null) toast.dismiss(id)
  else showActionToast(id, next)
  return result
}
