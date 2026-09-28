// #98: the third lazy Agent SDK seam, alongside `sessions/sdk.ts` (#78) and
// `runtime/sdk.ts` (#97) — the `desktop-sessions` layer 1 check's own
// allowlist names all three. Exposes exactly `query` and `renameSession`; no
// other SDK export enters this tree. The three type-only re-exports below
// are the one way the rest of `main/hosting/` reaches `Options`/`SDKMessage`/
// `SDKUserMessage` — every other file imports them from here, never from
// the package directly, which is what keeps this the only file naming the
// package specifier at all.
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export type { Options, SDKMessage, SDKUserMessage }

/** The narrow structural slice of the real `Query` this app needs, the same
 *  idiom `runtime/sdk.ts`'s own `SdkQuery`/`ProbeMessage` already use — the
 *  real `Query` (`query()`'s own return type) structurally satisfies this,
 *  so a test fake needs no unrelated method off the real 20-plus-method
 *  interface. */
export interface HostedQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<{ readonly still_queued: readonly string[] } | undefined>
  close(): void
}

/** The two functions this app calls, typed narrowly rather than re-exporting
 *  the SDK's own module type — a fake in `sdk.test.ts` needs no unrelated
 *  export. */
export interface HostedSdk {
  readonly query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => HostedQuery
  readonly renameSession: (sessionId: string, title: string, options?: { readonly dir?: string }) => Promise<void>
}

/** `createHostedSdk` is a factory, not a bare export, so a test can inject a
 *  fake `importSdk` that never touches the real package — the default
 *  parameter is the **only** call in this tree that does, a lazy dynamic
 *  `import()` inside the returned closure, never at module load (the same
 *  idiom `sessions/sdk.ts`'s `createSdkSessionReader` and `runtime/sdk.ts`'s
 *  `createRuntimeProbe` already use). Every call re-imports rather than
 *  caching — a rejected import (the module genuinely missing) must not wedge
 *  every later session start behind one remembered failure. */
export function createHostedSdk(importSdk: () => Promise<HostedSdk> = () => import('@anthropic-ai/claude-agent-sdk')): () => Promise<HostedSdk> {
  return () => importSdk()
}
