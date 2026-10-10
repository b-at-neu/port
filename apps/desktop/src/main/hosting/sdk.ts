// One of three lazy Agent SDK seams, the only file in main/hosting/ naming the package specifier,
// exposing exactly `query` and `renameSession`. Every other file imports its types from here.
import type { AgentInfo, CanUseTool, EffortLevel, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'

export type { AgentInfo, CanUseTool, EffortLevel, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage, SlashCommand }

/** The narrow structural slice of the real `Query` this app needs, so a test fake
 *  needs no unrelated method off the real interface. */
export interface HostedQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<{ readonly still_queued: readonly string[] } | undefined>
  close(): void
  supportedCommands(): Promise<SlashCommand[]>
  supportedAgents(): Promise<AgentInfo[]>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>
  supportedModels(): Promise<ModelInfo[]>
  stopTask(taskId: string): Promise<void>
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
