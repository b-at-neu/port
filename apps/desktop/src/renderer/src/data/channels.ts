// The read/write partition over `IpcChannel` (#316) — `query.ts` only ever
// lets `useIpcQuery` take a `QueryChannel` and `useIpcMutation` take a
// `MutationChannel`, so a channel that moves state can never be cached as
// though it were a read. Both lists are hand-maintained, deliberately never
// derived from each other or from `IPC_CHANNELS`: a new channel must be
// classified by a human before it typechecks anywhere in `data/`.
import type { IpcChannel } from '../../../shared/ipc'
import type { AssertEqual } from '../../../shared/assert-type'

export const QUERY_CHANNELS = [
  'app:info',
  'repos:list',
  'worktrees:report',
  'sessions:scan',
  'transcript:read',
  'search:query',
  'board:snapshot',
  'claim:preflight',
  'runtime:preflight',
  'gate:preflight',
  'gate:claim:read',
  'session:list',
  'session:capacity',
  'session:restore:list',
] as const

export type QueryChannel = (typeof QUERY_CHANNELS)[number]

/** Every other channel — including `runtime:probe` (a real agent turn) and
 *  the `transcript:tail:*` channels (they move a cursor in the main
 *  process). */
export const MUTATION_CHANNELS = [
  'repos:add',
  'repos:remove',
  'transcript:tail:open',
  'transcript:tail:poll',
  'transcript:tail:close',
  'board:refresh',
  'claim:apply',
  'item:action',
  'dispatch:control',
  'dispatch:claim:set',
  'dispatch:relay',
  'runtime:probe',
  'gate:claim:set',
  'gate:answer',
  'relay:copy',
  'session:start',
  'session:send',
  'session:interrupt',
  'session:close',
  'session:attach',
  'session:permission:answer',
  'session:invoke',
  'session:dismiss',
  'session:capacity:set',
  'session:restore',
  'session:restore:discard',
] as const

export type MutationChannel = (typeof MUTATION_CHANNELS)[number]

// Fails to compile when a channel is unclassified, misclassified into both
// lists, or either list drifts from IpcMap's own keys.
export const _queryAndMutationCoverIpcChannel: AssertEqual<QueryChannel | MutationChannel, IpcChannel> = true
export const _queryAndMutationNeverOverlap: AssertEqual<QueryChannel & MutationChannel, never> = true
