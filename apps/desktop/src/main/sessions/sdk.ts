// The session reader seam (#78) and the single lazy import of the Agent
// SDK. This is the only file under apps/desktop/src/ that may reference
// `@anthropic-ai/claude-agent-sdk` — the `desktop-sessions` layer 1 check
// pins that mechanically, in the shape `desktop-registry.mjs` already pins
// for `schema/port.config.schema.json`.
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { SessionFailureKind } from '../../shared/sessions/types'

/** This repository's own copy of `listSessions`'s result, mapped at the
 *  boundary from the SDK's `SDKSessionInfo` — every optional field carried
 *  as `null` rather than `undefined`, so a caller never has to know the
 *  SDK's own optionality rules. `lastModified` is normalized to an ISO
 *  string here, the one place the app converts the SDK's epoch-millisecond
 *  clock into the string every other activity field already uses. */
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

/** The injectable seam every caller takes instead of importing the SDK
 *  directly — the same idiom `GhRunner` (`main/github/adapter.ts`) and
 *  `Spawner` (`platform/run.ts`) already use, so `adapter.test.ts` runs with
 *  no SDK present. */
export type SessionReader = () => Promise<ListSessionsResult>

/** Only the one function this adapter calls (Decision 3: `listSubagents`
 *  and `getSubagentMessages` are deliberately not used) — never the whole
 *  SDK module type, so a fake in `sdk.test.ts` needs no unrelated exports. */
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

/** `createSdkSessionReader` is a factory rather than a bare export, so a
 *  test can inject a fake `importSdk` that never touches the real package —
 *  the default parameter is the **only** call in this tree that does, and it
 *  is a lazy dynamic `import()` inside the returned closure, never at module
 *  load: an absent or unresolvable SDK becomes a returned `sdk-unavailable`
 *  value the first time a caller actually reads sessions, not a throw the
 *  moment this module is imported. */
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
