import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type IpcChannel, type IpcMap } from '../shared/ipc'

type CamelCase<S extends string> = S extends `${infer Head}:${infer Rest}`
  ? `${Head}${Capitalize<CamelCase<Rest>>}`
  : S

export type PortBridge = {
  [C in IpcChannel as CamelCase<C>]: (request?: IpcMap[C]['request']) => Promise<IpcMap[C]['response']>
}

function toCamelCase(channel: string): string {
  return channel.replace(/:([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

const bridge = Object.fromEntries(
  IPC_CHANNELS.map((channel) => [
    toCamelCase(channel),
    (request?: IpcMap[typeof channel]['request']) => ipcRenderer.invoke(channel, request)
  ])
) as PortBridge

contextBridge.exposeInMainWorld('port', bridge)
