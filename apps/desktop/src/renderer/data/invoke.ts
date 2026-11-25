// The one place a request actually crosses the bridge — every
// `useIpcQuery`/`useIpcMutation` call funnels through this function, never
// `window.port` directly, so a future transport change touches one file.
import type { ActionInput, ActionName, ActionOutput } from '@/types/ipc'

export function invoke<N extends ActionName>(name: N, request?: ActionInput<N>): Promise<ActionOutput<N>> {
  return window.port.invoke(name, request)
}
