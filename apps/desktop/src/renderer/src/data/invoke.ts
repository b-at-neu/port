// The one place a request actually crosses the bridge (#316) — every
// `useIpcQuery`/`useIpcMutation` call funnels through this function, never
// `window.port` directly, so a future transport change touches one file.
import { bridgeMethodName } from '../../../shared/ipc'
import type { IpcMap } from '../../../shared/ipc'
import type { MutationChannel, QueryChannel } from './channels'

type DataChannel = QueryChannel | MutationChannel

export async function invoke<C extends DataChannel>(channel: C, request?: IpcMap[C]['request']): Promise<IpcMap[C]['response']> {
  const method = bridgeMethodName(channel)
  // The one type assertion in data/ — PortBridge is typed per-literal-channel,
  // and TypeScript cannot narrow a generic `C` back to its own indexed method
  // without this cast; every caller above stays fully typed.
  const call = window.port[method] as (req?: IpcMap[C]['request']) => Promise<IpcMap[C]['response']>
  return call(request)
}
