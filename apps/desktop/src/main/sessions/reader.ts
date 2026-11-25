import { defaultSdk, type SDKSessionInfo, type SdkSource } from '@/main/platform/sdk'
import type { SessionReader, RawSession } from '@/types/sessions'

function toRawSession(info: SDKSessionInfo): RawSession {
  return {
    sessionId: info.sessionId,
    summary: typeof info.summary === 'string' && info.summary !== '' ? info.summary : null,
    lastModified: new Date(info.lastModified).toISOString(),
    customTitle: info.customTitle ?? null,
    firstPrompt: info.firstPrompt ?? null,
    gitBranch: info.gitBranch ?? null,
    cwd: info.cwd ?? null,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSdkSessionReader(sdk: SdkSource<'listSessions'> = defaultSdk): SessionReader {
  return async () => {
    let loaded: Awaited<ReturnType<typeof sdk.load>>
    try {
      loaded = await sdk.load()
    } catch (error) {
      return { ok: false, kind: 'sdk-unavailable', message: messageOf(error) }
    }
    try {
      const raw = await loaded.listSessions()
      return { ok: true, sessions: raw.map(toRawSession) }
    } catch (error) {
      return { ok: false, kind: 'sdk-failed', message: messageOf(error) }
    }
  }
}
