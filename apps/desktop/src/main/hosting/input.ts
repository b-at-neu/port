// Streaming input mode, always, so interrupt()/setPermissionMode() stay available for the handle's whole life.
// end() closes the iterator, the SDK's own graceful-shutdown trigger — never process.kill or a signal.
import type { SDKUserMessage } from './sdk'

export interface PushResult {
  readonly uuid: string
}

export interface HostedInput {
  /** Iterable exactly once. */
  readonly stream: AsyncIterable<SDKUserMessage>
  /** Always accepted; dropped silently once `end()` has been called. */
  push(text: string): PushResult
  /** Idempotent: a second call is a no-op. */
  end(): void
}

type PendingResolve = (result: IteratorResult<SDKUserMessage, undefined>) => void

/** `globalThis.crypto.randomUUID()`, never `node:crypto`. */
export function createHostedInput(): HostedInput {
  const queue: SDKUserMessage[] = []
  let pendingResolve: PendingResolve | null = null
  let ended = false

  function deliver(message: SDKUserMessage): void {
    // A push() after end() must not resurrect the iterator; the message is dropped.
    if (ended) return
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
