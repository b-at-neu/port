// The module's public surface (#87) — `main/ipc.ts` imports `runSearch`
// from here only, never a deep path, the same barrel contract every other
// `main/*` directory holds.
export type { RunSearchParams } from './query'
export { runSearch } from './query'
