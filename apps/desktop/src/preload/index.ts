import { contextBridge, ipcRenderer } from 'electron'
import type { ActionInput, ActionName, ActionOutput, EventMap, EventName } from '@/types/ipc'

export interface PortBridge {
  readonly invoke: <N extends ActionName>(name: N, input?: ActionInput<N>) => Promise<ActionOutput<N>>
  /** Payload only — the Electron event would hand `sender` to a sandboxed renderer. */
  readonly on: <E extends EventName>(event: E, listener: (payload: EventMap[E]) => void) => () => void
}

// Main registers only router names, so an unknown name that passes this shape guard still rejects with "no handler".
const NAME_SHAPE = /^[a-z]+\.[a-zA-Z]+$/

function requireName(name: string): string {
  if (!NAME_SHAPE.test(name)) throw new Error(`'${name}' is not an action or event name`)
  return name
}

const bridge: PortBridge = {
  invoke: (name, input) => ipcRenderer.invoke(requireName(name), input) as never,
  on: (event, listener) => {
    const channel = requireName(event)
    const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: EventMap[typeof event]): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
}

contextBridge.exposeInMainWorld('port', bridge)
