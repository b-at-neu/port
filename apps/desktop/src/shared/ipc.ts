export interface AppInfo {
  app: string
  electron: string
  node: string
  chromium: string
}

export interface IpcMap {
  'app:info': {
    request: void
    response: AppInfo
  }
}

export const IPC_CHANNELS = ['app:info'] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// Fails to compile if IPC_CHANNELS and IpcMap's keys drift apart.
export const _channelsMatchIpcMap: AssertEqual<IpcChannel, keyof IpcMap> = true
