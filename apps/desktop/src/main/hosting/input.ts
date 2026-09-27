// #98: the push queue behind `prompt` — streaming input mode, always, so
// `interrupt()`/`setPermissionMode()` (documented as "only supported when
// streaming input/output is used") stay available for the handle's whole
// life. `push(text)` stamps a `uuid` and resolves the pending `next()`;
// `end()` closes the iterator, which is the SDK's own graceful-shutdown
// trigger (stdin EOF → ~2s grace → abort). Never `process.kill` and never a
// signal — the SDK owns termination, which is what makes close identical on
// Windows.
import type { SDKUserMessage } from './sdk'

export interface PushResult {
  readonly uuid: string
}

export interface HostedInput {
  /** The `AsyncIterable` this handle's `query()` call takes as `prompt` —
   *  iterable exactly once, the same restriction every push-driven async
   *  iterator in this app already carries. */
  readonly stream: AsyncIterable<SDKUserMessage>
  /** Always accepted, never refused mid-turn — the SDK owns the queue. */
  push(text: string): PushResult
  /** Idempotent: a second call is a no-op, since a handle may call this from
   *  both its own `close()` and a caller that raced it. */
  end(): void
}

type PendingResolve = (result: IteratorResult<SDKUserMessage, undefined>) => void

/** `globalThis.crypto.randomUUID()`, never `node:crypto` — the uuid stamp is
 *  the one piece of Node-shaped logic this file would otherwise need, and
 *  the Web Crypto global already provides it. */
export function createHostedInput(): HostedInput {
  const queue: SDKUserMessage[] = []
  let pendingResolve: PendingResolve | null = null
  let ended = false

  function deliver(message: SDKUserMessage): void {
    if (pendingResolve !== null) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve({ done: false, value: message })
      return
    }
    queue.push(message)
  }

  const stream: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage, undefined>> {
          const next = queue.shift()
          if (next !== undefined) return Promise.resolve({ done: false, value: next })
          if (ended) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
      }
    },
  }

  return {
    stream,
    push(text) {
      const uuid = globalThis.crypto.randomUUID()
      deliver({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid })
      return { uuid }
    },
    end() {
      if (ended) return
      ended = true
      if (pendingResolve !== null) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: true, value: undefined })
      }
    },
  }
}
