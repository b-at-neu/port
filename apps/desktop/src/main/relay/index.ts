// The module's only import path for consumers (#107) — `main/state/
// watcher.ts` and `main/ipc.ts` import `createRelayReader`/`copyRelayReply`
// through here only, never `./read` or `./clipboard` directly.
export type { ReadRelayStateParams, RelayReader } from './read'
export { MAX_RELAY_CANDIDATES, RELAY_BUDGET_MS, RELAY_TAIL_BYTES, createRelayReader } from './read'

export type { CopyRelayReplyParams, CopyRelayReplyResult } from './clipboard'
export { MAX_REPLY_CHARS, copyRelayReply } from './clipboard'
