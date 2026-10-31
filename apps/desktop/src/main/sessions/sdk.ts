// The only file under apps/desktop/src/ that may reference `@anthropic-ai/claude-agent-sdk` — pinned mechanically by the `desktop-sessions` layer 1 check.
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { SessionReader, RawSession } from '@/types/sessions'

/** Only the one function this adapter calls, never the whole SDK module type, so a fake in `sdk.test.ts` needs no unrelated exports. */
type SdkListSessions = () => Promise<SDKSessionInfo[]>

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

/** A factory so a test can inject a fake `importSdk`; the default is a lazy dynamic `import()`, never at module load. */
export function createSdkSessionReader(
  importSdk: () => Promise<{ listSessions: SdkListSessions }> = () => import('@anthropic-ai/claude-agent-sdk'),
): SessionReader {
  return async () => {
    let sdk: { listSessions: SdkListSessions }
    try {
      sdk = await importSdk()
    } catch (error) {
      return { ok: false, kind: 'sdk-unavailable', message: messageOf(error) }
    }
    try {
      const raw = await sdk.listSessions()
      return { ok: true, sessions: raw.map(toRawSession) }
    } catch (error) {
      return { ok: false, kind: 'sdk-failed', message: messageOf(error) }
    }
  }
}
