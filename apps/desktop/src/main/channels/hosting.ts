// The seven hosted-session channels' validation and registry resolution
// (#98, #99) — everything a stale renderer could get wrong throws here, never a
// value `main/hosting/store.ts` has to defend against, the same rail every
// other channel already applies. `repoId` resolves through the same
// `listRepositories` ready-entry rail `resolveWorktreesReport`/
// `resolveClaimPreflight` already use; an unresolvable executable returns
// #97's own diagnosis rather than a new error kind (that is `HostedStore`'s
// own job, not this file's).
import type { IpcMap, ReposListResponse } from '../../shared/ipc'
import type { RepoId, RepoProblem, RepositoryEntry } from '../../shared/repos'
import { PERMISSION_DECISIONS } from '../../shared/hosting/types'
import type { RestorableSession, SessionStartMode } from '../../shared/hosting/types'
import type { HostedStore } from '../hosting'
import { SESSION_LIMIT_CEILING } from '../hosting'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'

export interface HostingChannelDeps {
  readonly listRepositories: typeof listRepositories
  readonly store: HostedStore
}

export const defaultHostingChannelDeps = (store: HostedStore): HostingChannelDeps => ({ listRepositories, store })

type ReadyEntry = Extract<RepositoryEntry, { readonly status: 'ready' }>

function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

async function resolveReadyEntry(registryDeps: RegistryDeps, repoId: unknown, deps: HostingChannelDeps, channel: string): Promise<ReadyEntry> {
  if (typeof repoId !== 'string' || repoId === '') throw new Error(`'${channel}' requires a non-empty 'repoId'`)
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'${channel}' could not list repositories: ${list.message}`)
  const entry = list.repositories.find((repository) => repository.id === repoId)
  if (!entry) throw new Error(`'${channel}' found no repository registered with id '${repoId}'`)
  if (!isReadyEntry(entry)) throw new Error(`'${channel}' requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
}

/** `mode.kind` one of `fresh | resume | resume-at | fork`, with `sessionId`
 *  a non-empty string for the latter three and `messageUuid` required for
 *  `resume-at`; `resumeDropsTurn` is optional there and, when present, a
 *  non-empty string. Anything else throws rather than reaching
 *  `buildSessionOptions` with a shape it was never built to defend
 *  against. */
function isValidStartMode(value: unknown): value is SessionStartMode {
  if (typeof value !== 'object' || value === null) return false
  const mode = value as Record<string, unknown>
  const sessionId = mode['sessionId']
  switch (mode['kind']) {
    case 'fresh':
      return true
    case 'resume':
    case 'fork':
      return typeof sessionId === 'string' && sessionId !== ''
    case 'resume-at': {
      const messageUuid = mode['messageUuid']
      const resumeDropsTurn = mode['resumeDropsTurn']
      return (
        typeof sessionId === 'string' &&
        sessionId !== '' &&
        typeof messageUuid === 'string' &&
        messageUuid !== '' &&
        (resumeDropsTurn === null || resumeDropsTurn === undefined || (typeof resumeDropsTurn === 'string' && resumeDropsTurn !== ''))
      )
    }
    default:
      return false
  }
}

export async function resolveSessionStart(registryDeps: RegistryDeps, request: IpcMap['session:start']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['start']> {
  const entry = await resolveReadyEntry(registryDeps, request?.repoId, deps, 'session:start')
  if (!isValidStartMode(request.mode)) {
    throw new Error(
      "'session:start' requires 'mode.kind' to be one of fresh | resume | resume-at | fork, with a non-empty 'sessionId' for the latter three and a non-empty 'messageUuid' for resume-at",
    )
  }
  return deps.store.start({ repoId: entry.id, mode: request.mode, cwd: entry.path })
}

export function resolveSessionSend(request: IpcMap['session:send']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['send']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:send' requires a non-empty 'sessionKey'")
  if (typeof request.text !== 'string' || request.text === '') throw new Error("'session:send' requires a non-empty 'text'")
  return deps.store.send(request.sessionKey, request.text)
}

export function resolveSessionInterrupt(request: IpcMap['session:interrupt']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['interrupt']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:interrupt' requires a non-empty 'sessionKey'")
  return deps.store.interrupt(request.sessionKey)
}

export function resolveSessionClose(request: IpcMap['session:close']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['close']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:close' requires a non-empty 'sessionKey'")
  return deps.store.close(request.sessionKey)
}

export function resolveSessionAttach(request: IpcMap['session:attach']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['attach']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:attach' requires a non-empty 'sessionKey'")
  return deps.store.attach(request.sessionKey)
}

export function resolveSessionList(request: IpcMap['session:list']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['list']> {
  if (request !== undefined) throw new Error("'session:list' takes no payload")
  return deps.store.list()
}

/** `sessionKey`/`permissionId` non-empty strings, `decision` one of
 *  `PERMISSION_DECISIONS`, `message` either `null` or a string of 1–2000
 *  characters, and a non-null `message` only ever alongside `'deny'` — every
 *  one of these can only come from a stale or buggy renderer, so each
 *  throws rather than reaching `HostedStore.answerPermission` with a shape
 *  it was never built to defend against. */
/** #101: the shape rail every channel uses. `name`'s content is **not**
 *  validated here — that is a typed result from `HostedStore.invoke`
 *  (`invalid-command`/`unknown-command`), so the UI can show it rather than
 *  the channel throwing on a name the operator might legitimately click. */
export const MAX_INVOKE_ARGS_CHARS = 8_000

export function resolveSessionInvoke(request: IpcMap['session:invoke']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['invoke']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:invoke' requires a non-empty 'sessionKey'")
  if (typeof request.name !== 'string' || request.name === '') throw new Error("'session:invoke' requires a non-empty 'name'")
  if (typeof request.args !== 'string' || request.args.length > MAX_INVOKE_ARGS_CHARS) throw new Error(`'session:invoke' requires 'args' to be a string of at most ${MAX_INVOKE_ARGS_CHARS} characters`)
  return deps.store.invoke(request.sessionKey, request.name, request.args)
}

export function resolveSessionPermissionAnswer(
  request: IpcMap['session:permission:answer']['request'],
  deps: HostingChannelDeps,
): ReturnType<HostedStore['answerPermission']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:permission:answer' requires a non-empty 'sessionKey'")
  if (typeof request.permissionId !== 'string' || request.permissionId === '') throw new Error("'session:permission:answer' requires a non-empty 'permissionId'")
  if (!(PERMISSION_DECISIONS as readonly string[]).includes(request.decision)) {
    throw new Error(`'session:permission:answer' requires 'decision' to be one of ${PERMISSION_DECISIONS.join(', ')}`)
  }
  const message: unknown = request.message
  if (message !== null && (typeof message !== 'string' || message.length < 1 || message.length > 2000)) {
    throw new Error("'session:permission:answer' requires 'message' to be null or a string of 1-2000 characters")
  }
  if (message !== null && request.decision !== 'deny') {
    throw new Error("'session:permission:answer' requires 'message' to be null when 'decision' is not 'deny'")
  }
  return deps.store.answerPermission(request.sessionKey, request.permissionId, request.decision, message)
}

/** #103: `session:dismiss` — removes an ended handle from the rail. */
export function resolveSessionDismiss(request: IpcMap['session:dismiss']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['dismiss']> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') throw new Error("'session:dismiss' requires a non-empty 'sessionKey'")
  return deps.store.dismiss(request.sessionKey)
}

export function resolveSessionCapacity(request: IpcMap['session:capacity']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['capacity']> {
  if (request !== undefined) throw new Error("'session:capacity' takes no payload")
  return deps.store.capacity()
}

export function resolveSessionCapacitySet(request: IpcMap['session:capacity:set']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['setLimit']> {
  if (typeof request?.limit !== 'number' || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > SESSION_LIMIT_CEILING) {
    throw new Error(`'session:capacity:set' requires 'limit' to be an integer from 1 to ${String(SESSION_LIMIT_CEILING)}`)
  }
  return deps.store.setLimit(request.limit)
}

/** A short, main-process-only reason string for a repository that cannot
 *  host a restore — never the renderer's own `problemCopy`
 *  (`renderer/src/repositories.ts`), which is written for the repository
 *  card rather than a one-line restore-banner reason. */
function problemReason(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return 'its folder is gone'
    case 'not-a-git-repository':
      return "it isn't a git repository anymore"
    case 'not-port-managed':
      return "it's no longer port-managed"
    case 'config-malformed':
      return '.claude/port.config.json is not valid JSON'
    case 'config-invalid':
      return '.claude/port.config.json has no usable repo'
    case 'config-unreadable':
      return "its config can't be read"
  }
}

function availabilityFor(repoId: RepoId, list: ReposListResponse): RestorableSession['availability'] {
  if (!list.ok) return { ok: false, reason: list.message }
  const found = list.repositories.find((repository) => repository.id === repoId)
  if (found === undefined) return { ok: false, reason: 'This repository is no longer registered.' }
  if (!isReadyEntry(found)) return { ok: false, reason: problemReason(found.problem) }
  return { ok: true }
}

/** #103: `session:restore:list` — joins every restorable entry with
 *  `listRepositories` for availability. A listing failure marks every entry
 *  unavailable with its message, rather than ever returning an empty list
 *  for a read that failed. */
export async function resolveSessionRestoreList(registryDeps: RegistryDeps, request: IpcMap['session:restore:list']['request'], deps: HostingChannelDeps): Promise<IpcMap['session:restore:list']['response']> {
  if (request !== undefined) throw new Error("'session:restore:list' takes no payload")
  const [entries, list] = await Promise.all([deps.store.restorable(), deps.listRepositories(registryDeps)])
  return {
    entries: entries.map((entry) => ({
      restoreId: entry.restoreId,
      repoId: entry.repoId,
      title: entry.title,
      origin: { kind: 'resumed' as const, from: entry.claudeSessionId },
      startedAt: entry.startedAt,
      availability: availabilityFor(entry.repoId, list),
    })),
  }
}

/** #103: `session:restore` — resolves the ready entry's own path itself and
 *  returns `repo-unavailable` as a value rather than throwing, since an
 *  operator can hit that state in normal use (the registered repository
 *  moved, or was removed, since the entry was offered). */
export async function resolveSessionRestore(registryDeps: RegistryDeps, request: IpcMap['session:restore']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['restore']> {
  if (typeof request?.restoreId !== 'string' || request.restoreId === '') throw new Error("'session:restore' requires a non-empty 'restoreId'")

  const entries = await deps.store.restorable()
  const entry = entries.find((candidate) => candidate.restoreId === request.restoreId)
  if (entry === undefined) return { ok: false, kind: 'unknown-restore' }

  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) return { ok: false, kind: 'repo-unavailable', reason: list.message }
  const repository = list.repositories.find((candidate) => candidate.id === entry.repoId)
  if (repository === undefined) return { ok: false, kind: 'repo-unavailable', reason: 'This repository is no longer registered.' }
  if (!isReadyEntry(repository)) return { ok: false, kind: 'repo-unavailable', reason: problemReason(repository.problem) }

  return deps.store.restore(request.restoreId, repository.path)
}

/** #103: `session:restore:discard` — `restoreId: null` discards every
 *  entry, idempotently either way. */
export function resolveSessionRestoreDiscard(request: IpcMap['session:restore:discard']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['discardRestorable']> {
  if (request === undefined || (request.restoreId !== null && (typeof request.restoreId !== 'string' || request.restoreId === ''))) {
    throw new Error("'session:restore:discard' requires 'restoreId' to be null or a non-empty string")
  }
  return deps.store.discardRestorable(request.restoreId)
}
