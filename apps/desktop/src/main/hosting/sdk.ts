// #98: the third lazy Agent SDK seam, alongside `sessions/sdk.ts` (#78) and
// `runtime/sdk.ts` (#97) — the `desktop-sessions` layer 1 check's own
// allowlist names all three. Exposes exactly `query` and `renameSession`; no
// other SDK export enters this tree. The type-only re-exports below are the
// one way the rest of `main/hosting/` reaches `Options`/`SDKMessage`/
// `SDKUserMessage`/`CanUseTool`/`PermissionResult`/`PermissionUpdate` — every
// other file imports them from here, never from the package directly, which
// is what keeps this the only file naming the package specifier at all.
import type { AgentInfo, CanUseTool, EffortLevel, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'

export type { AgentInfo, CanUseTool, EffortLevel, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage, SlashCommand }

/** The narrow structural slice of the real `Query` this app needs, the same
 *  idiom `runtime/sdk.ts`'s own `SdkQuery`/`ProbeMessage` already use — the
 *  real `Query` (`query()`'s own return type) structurally satisfies this,
 *  so a test fake needs no unrelated method off the real 20-plus-method
 *  interface. `supportedCommands`/`supportedAgents`/`supportedModels` are
 *  control requests, so a fake need not drive a turn to answer them; only
 *  `effortLevel` is ever passed to `applyFlagSettings`. */
export interface HostedQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<{ readonly still_queued: readonly string[] } | undefined>
  close(): void
  supportedCommands(): Promise<SlashCommand[]>
  supportedAgents(): Promise<AgentInfo[]>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>
  supportedModels(): Promise<ModelInfo[]>
}

/** Typed narrowly rather than re-exporting the SDK's own module type. */
export interface HostedSdk {
  readonly query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => HostedQuery
  readonly renameSession: (sessionId: string, title: string, options?: { readonly dir?: string }) => Promise<void>
}

/** A factory so a test can inject a fake `importSdk`. Every call re-imports rather than caching,
 *  so a rejected import never wedges every later session start behind one remembered failure. */
export function createHostedSdk(importSdk: () => Promise<HostedSdk> = () => import('@anthropic-ai/claude-agent-sdk')): () => Promise<HostedSdk> {
  return () => importSdk()
}
