import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, type IpcChannel, type IpcEvent, type IpcEventMap, type IpcMap } from '../shared/ipc'

type CamelCase<S extends string> = S extends `${infer Head}:${infer Rest}`
  ? `${Head}${Capitalize<CamelCase<Rest>>}`
  : S

type OnEventName<E extends string> = `on${Capitalize<CamelCase<E>>}`

export type PortBridge = {
  [C in IpcChannel as CamelCase<C>]: (request?: IpcMap[C]['request']) => Promise<IpcMap[C]['response']>
} & {
  /** The listener receives the payload only — never the Electron event
   *  object, which would hand `sender` to a sandboxed renderer. Returns an
   *  unsubscribe function, the same shape every DOM `addEventListener`
   *  caller already expects. */
  [E in IpcEvent as OnEventName<E>]: (listener: (payload: IpcEventMap[E]) => void) => () => void
}

function toCamelCase(channel: string): string {
  return channel.replace(/:([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function toOnEventName(event: string): string {
  const camel = toCamelCase(event)
  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
}

const invokers = Object.fromEntries(
  IPC_CHANNELS.map((channel) => [
    toCamelCase(channel),
    (request?: IpcMap[typeof channel]['request']) => ipcRenderer.invoke(channel, request)
  ])
)

const subscribers = Object.fromEntries(
  IPC_EVENTS.map((event) => [
    toOnEventName(event),
    (listener: (payload: IpcEventMap[typeof event]) => void) => {
      const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: IpcEventMap[typeof event]): void => listener(payload)
      ipcRenderer.on(event, handler)
      return () => ipcRenderer.removeListener(event, handler)
    }
  ])
)

const bridge = { ...invokers, ...subscribers } as unknown as PortBridge

contextBridge.exposeInMainWorld('port', bridge)
