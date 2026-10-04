import { contextBridge, ipcRenderer } from 'electron'
import {
  bridgeListenerName,
  bridgeMethodName,
  IPC_CHANNELS,
  IPC_EVENTS,
  type BridgeListener,
  type BridgeMethod,
  type IpcChannel,
  type IpcEvent,
  type IpcEventMap,
  type IpcMap,
} from '../shared/ipc'

export type PortBridge = {
  [C in IpcChannel as BridgeMethod<C>]: (request?: IpcMap[C]['request']) => Promise<IpcMap[C]['response']>
} & {
  /** The listener receives the payload only — never the Electron event
   *  object, which would hand `sender` to a sandboxed renderer. Returns an
   *  unsubscribe function, the same shape every DOM `addEventListener`
   *  caller already expects. */
  [E in IpcEvent as BridgeListener<E>]: (listener: (payload: IpcEventMap[E]) => void) => () => void
}

const invokers = Object.fromEntries(
  IPC_CHANNELS.map((channel) => [
    bridgeMethodName(channel),
    (request?: IpcMap[typeof channel]['request']) => ipcRenderer.invoke(channel, request)
  ])
)

const subscribers = Object.fromEntries(
  IPC_EVENTS.map((event) => [
    bridgeListenerName(event),
    (listener: (payload: IpcEventMap[typeof event]) => void) => {
      const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: IpcEventMap[typeof event]): void => listener(payload)
      ipcRenderer.on(event, handler)
      return () => ipcRenderer.removeListener(event, handler)
    }
  ])
)

const bridge = { ...invokers, ...subscribers } as unknown as PortBridge

contextBridge.exposeInMainWorld('port', bridge)
