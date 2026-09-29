// The seven hosted-session channels' validation and registry resolution
// (#98, #99) — everything a stale renderer could get wrong throws here, never a
// value `main/hosting/store.ts` has to defend against, the same rail every
// other channel already applies. `repoId` resolves through the same
// `listRepositories` ready-entry rail `resolveWorktreesReport`/
// `resolveClaimPreflight` already use; an unresolvable executable returns
// #97's own diagnosis rather than a new error kind (that is `HostedStore`'s
// own job, not this file's).
import type { IpcMap } from '../../shared/ipc'
import type { RepositoryEntry } from '../../shared/repos'
import { PERMISSION_DECISIONS } from '../../shared/hosting/types'
import type { SessionStartMode } from '../../shared/hosting/types'
import type { HostedStore } from '../hosting'
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
