// The only file under apps/desktop/src/ that may reference `@anthropic-ai/claude-agent-sdk` at runtime.
import type {
  AgentInfo,
  CanUseTool,
  EffortLevel,
  HookCallback,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'

export type { AgentInfo, CanUseTool, EffortLevel, HookCallback, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, SDKMessage, SDKSessionInfo, SDKUserMessage, SlashCommand }

export type HostedQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => HostedQuery

/** The narrow structural slice of the real `Query` this app needs, so a test fake needs no unrelated method off the real interface. */
export interface HostedQuery extends AsyncIterable<unknown> {
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

export interface SdkModule {
  readonly query: HostedQueryFn
  readonly renameSession: (sessionId: string, title: string, options?: { readonly dir?: string }) => Promise<void>
  readonly listSessions: () => Promise<SDKSessionInfo[]>
}

export type HostedSdk = Pick<SdkModule, 'query' | 'renameSession'>

/** A consumer names only the members it calls, so a test fake needs no unrelated export. */
export interface SdkSource<K extends keyof SdkModule = keyof SdkModule> {
  readonly load: () => Promise<Pick<SdkModule, K>>
}

export type Sdk = SdkSource

/** Every call re-imports rather than caching, so one rejected import never wedges later calls behind a remembered failure. */
export function createSdk(importSdk: () => Promise<SdkModule> = () => import('@anthropic-ai/claude-agent-sdk')): Sdk {
  return { load: () => importSdk() }
}

export const defaultSdk: Sdk = createSdk()
