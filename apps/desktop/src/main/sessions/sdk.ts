// The only file under apps/desktop/src/ that may reference `@anthropic-ai/claude-agent-sdk` — pinned mechanically by the `desktop-sessions` layer 1 check.
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { SessionFailureKind } from '../../shared/sessions/types'

/** Mapped from the SDK's `SDKSessionInfo` — optional fields carried as `null`, and `lastModified` normalized to an ISO string here. */
export interface RawSession {
  readonly sessionId: string
  readonly summary: string | null
  readonly lastModified: string
  readonly customTitle: string | null
  readonly firstPrompt: string | null
  readonly gitBranch: string | null
  readonly cwd: string | null
}

export type ListSessionsResult =
  | { readonly ok: true; readonly sessions: readonly RawSession[] }
  | { readonly ok: false; readonly kind: SessionFailureKind; readonly message: string }

/** The injectable seam every caller takes instead of importing the SDK directly, so `adapter.test.ts` runs with no SDK present. */
export type SessionReader = () => Promise<ListSessionsResult>

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
