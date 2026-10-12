import type { SessionUsage } from '@/utils/hosting/usage'

/** Which plugin path a session asked for — the repository's own copy (self-hosting) or the operator's installed one. Resolved once before spawn, carried on the snapshot so the operator sees it even before `init` confirms what loaded. */
export type PluginRequest = { readonly source: 'repository'; readonly path: string } | { readonly source: 'installed' }

/** What actually loaded, read back from the SDK rather than assumed. `unconfirmed` is the state before any `init` has arrived. */
export type PluginLoad =
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'loaded'; readonly path: string; readonly version: string | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'shadowed'; readonly path: string; readonly version: string | null }
  | { readonly kind: 'duplicate'; readonly paths: readonly string[] }

/** Whether the loaded plugin's skills/agents match what the plugin directory declares — `unchecked` when the directory could not be read, never reported as `complete`. */
export type ComponentCheck =
  | { readonly kind: 'unchecked'; readonly reason: 'no-plugin-path' | 'unreadable' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly missingSkills: readonly string[]; readonly missingAgents: readonly string[] }

export interface ExpectedComponents {
  readonly skills: readonly string[]
  readonly agents: readonly string[]
}

/** The shape `system`/`init`'s own `plugins` field carries, narrowed to what this module reads. */
export interface InitPlugin {
  readonly name: string
  readonly path: string
  readonly version?: string
}

/** `previous` carries the last-seen model (for `contextWindow` lookup on the next `result`) alongside the reading itself. */
export interface UsageReading {
  readonly usage: SessionUsage
  readonly model: string | null
}
