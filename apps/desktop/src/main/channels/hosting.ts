// Everything a stale renderer could get wrong throws here, never a value `main/hosting/store.ts`
// has to defend against.
import type { IpcMap, ReposListResponse } from '../../shared/ipc'
import type { RepoId, RepoProblem } from '../../shared/repos'
import { PERMISSION_DECISIONS, SESSION_MODELS, SESSION_PERMISSION_MODES, SESSION_TITLE_MAX } from '../../shared/hosting/types'
import type { RestorableSession, SessionKey, SessionModel, SessionPermissionMode, SessionStartMode } from '../../shared/hosting/types'
import { SESSION_EFFORTS } from '../../shared/hosting/controls'
import type { PlanDecision } from '../../shared/hosting/controls'
import { isRecord } from '../../shared/guards'
import type { HostedStore } from '../hosting/store'
import { SESSION_LIMIT_CEILING } from '../hosting/store'
import { isReadyEntry, listRepositories, requireReadyRepo, requireRepoId } from '../registry'
import type { RegistryDeps } from '../registry'
import type { ReadyEntry } from '../actions/apply'

export interface HostingChannelDeps {
  readonly listRepositories: typeof listRepositories
  readonly store: HostedStore
}

export const defaultHostingChannelDeps = (store: HostedStore): HostingChannelDeps => ({ listRepositories, store })

function resolveReadyEntry(registryDeps: RegistryDeps, repoId: unknown, deps: HostingChannelDeps, channel: string): Promise<ReadyEntry> {
  return requireReadyRepo(registryDeps, `'${channel}'`, requireRepoId(repoId, `'${channel}'`), deps.listRepositories)
}

function requireSessionKey(sessionKey: unknown, channel: string): SessionKey {
  if (typeof sessionKey !== 'string' || sessionKey === '') throw new Error(`'${channel}' requires a non-empty 'sessionKey'`)
  return sessionKey as SessionKey
}

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
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:send')
  if (typeof request.text !== 'string' || request.text === '') throw new Error("'session:send' requires a non-empty 'text'")
  return deps.store.send(sessionKey, request.text)
}

export function resolveSessionInterrupt(request: IpcMap['session:interrupt']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['interrupt']> {
  return deps.store.interrupt(requireSessionKey(request?.sessionKey, 'session:interrupt'))
}

export function resolveSessionClose(request: IpcMap['session:close']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['close']> {
  return deps.store.close(requireSessionKey(request?.sessionKey, 'session:close'))
}

export function resolveSessionAttach(request: IpcMap['session:attach']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['attach']> {
  return deps.store.attach(requireSessionKey(request?.sessionKey, 'session:attach'))
}

export function resolveSessionList(request: IpcMap['session:list']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['list']> {
  if (request !== undefined) throw new Error("'session:list' takes no payload")
  return deps.store.list()
}

/** `name`'s content is **not** validated here — that is a typed result from
 *  `HostedStore.invoke` (`invalid-command`/`unknown-command`). */
export const MAX_INVOKE_ARGS_CHARS = 8_000

export function resolveSessionInvoke(request: IpcMap['session:invoke']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['invoke']> {
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:invoke')
  if (typeof request.name !== 'string' || request.name === '') throw new Error("'session:invoke' requires a non-empty 'name'")
  if (typeof request.args !== 'string' || request.args.length > MAX_INVOKE_ARGS_CHARS) throw new Error(`'session:invoke' requires 'args' to be a string of at most ${MAX_INVOKE_ARGS_CHARS} characters`)
  return deps.store.invoke(sessionKey, request.name, request.args)
}

export function resolveSessionPermissionAnswer(
  request: IpcMap['session:permission:answer']['request'],
  deps: HostingChannelDeps,
): ReturnType<HostedStore['answerPermission']> {
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:permission:answer')
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
  return deps.store.answerPermission(sessionKey, request.permissionId, request.decision, message)
}

export function resolveSessionDismiss(request: IpcMap['session:dismiss']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['dismiss']> {
  return deps.store.dismiss(requireSessionKey(request?.sessionKey, 'session:dismiss'))
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

/** A short, main-process-only reason string, distinct from the renderer's own `problemCopy`. */
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
    case 'effective-config-unreadable':
      return `${problem.file} can't be read`
  }
}

function availabilityFor(repoId: RepoId, list: ReposListResponse): RestorableSession['availability'] {
  if (!list.ok) return { ok: false, reason: list.message }
  const found = list.repositories.find((repository) => repository.id === repoId)
  if (found === undefined) return { ok: false, reason: 'This repository is no longer registered.' }
  if (!isReadyEntry(found)) return { ok: false, reason: problemReason(found.problem) }
  return { ok: true }
}

/** A listing failure marks every entry unavailable with its message, never an empty list. */
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

/** Returns `repo-unavailable` as a value rather than throwing — an operator can hit this in normal use. */
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

/** `restoreId: null` discards every entry, idempotently either way. */
export function resolveSessionRestoreDiscard(request: IpcMap['session:restore:discard']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['discardRestorable']> {
  if (request === undefined || (request.restoreId !== null && (typeof request.restoreId !== 'string' || request.restoreId === ''))) {
    throw new Error("'session:restore:discard' requires 'restoreId' to be null or a non-empty string")
  }
  return deps.store.discardRestorable(request.restoreId)
}

/** The Settings screen's own read of an operator's persisted session defaults. */
export function resolveSessionDefaults(request: IpcMap['session:defaults']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['defaults']> {
  if (request !== undefined) throw new Error("'session:defaults' takes no payload")
  return deps.store.defaults()
}

/** The Settings screen's own write — each field must name an allowlisted
 *  value, `model` or `null`, before it ever reaches the store. */
export function resolveSessionDefaultsSet(request: IpcMap['session:defaults:set']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['setDefaults']> {
  const model: unknown = request?.model
  if (model !== null && (typeof model !== 'string' || !(SESSION_MODELS as readonly string[]).includes(model))) {
    throw new Error(`'session:defaults:set' requires 'model' to be null or one of ${SESSION_MODELS.join(', ')}`)
  }
  const permissionMode: unknown = request?.permissionMode
  if (typeof permissionMode !== 'string' || !(SESSION_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`'session:defaults:set' requires 'permissionMode' to be one of ${SESSION_PERMISSION_MODES.join(', ')}`)
  }
  return deps.store.setDefaults({ model: model as SessionModel | null, permissionMode: permissionMode as SessionPermissionMode })
}

/** The rename dialog's own write — `sessionKey` non-empty, `title` non-empty
 *  and at most `SESSION_TITLE_MAX` once trimmed. */
export function resolveSessionRename(request: IpcMap['session:rename']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['rename']> {
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:rename')
  const title = typeof request.title === 'string' ? request.title.trim() : ''
  if (title === '' || title.length > SESSION_TITLE_MAX) {
    throw new Error(`'session:rename' requires 'title' to be non-empty and at most ${String(SESSION_TITLE_MAX)} characters once trimmed`)
  }
  return deps.store.rename(sessionKey, title)
}

// At least one of permissionMode/model/effort must be present, each an allowlisted value.
export function resolveSessionControlsSet(request: IpcMap['session:controls:set']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['setControls']> {
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:controls:set')
  const { permissionMode, model, effort } = request
  if (permissionMode === undefined && model === undefined && effort === undefined) {
    throw new Error("'session:controls:set' requires at least one of 'permissionMode', 'model', or 'effort'")
  }
  if (permissionMode !== undefined && !(SESSION_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`'session:controls:set' requires 'permissionMode' to be one of ${SESSION_PERMISSION_MODES.join(', ')}`)
  }
  if (model !== undefined && (typeof model !== 'string' || model === '' || model.length > 200)) {
    throw new Error("'session:controls:set' requires 'model' to be a non-empty string of at most 200 characters")
  }
  if (effort !== undefined && effort !== null && !(SESSION_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`'session:controls:set' requires 'effort' to be null or one of ${SESSION_EFFORTS.join(', ')}`)
  }
  return deps.store.setControls(sessionKey, { permissionMode, model, effort })
}

// answers must be a plain object of strings up to 2000 characters; membership is the broker's own job.
export function resolveSessionQuestionAnswer(request: IpcMap['session:question:answer']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['answerQuestion']> {
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:question:answer')
  if (typeof request.permissionId !== 'string' || request.permissionId === '') throw new Error("'session:question:answer' requires a non-empty 'permissionId'")
  const answers = request.answers
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) throw new Error("'session:question:answer' requires 'answers' to be a plain object")
  for (const value of Object.values(answers)) {
    if (typeof value !== 'string' || value.length > 2000) throw new Error("'session:question:answer' requires every 'answers' value to be a string of at most 2000 characters")
  }
  return deps.store.answerQuestion(sessionKey, request.permissionId, answers)
}

// feedback is 1-2000 characters; approving into 'plan' itself is refused here, never reaching the store.
export function resolveSessionPlanAnswer(request: IpcMap['session:plan:answer']['request'], deps: HostingChannelDeps): ReturnType<HostedStore['answerPlan']> {
  const sessionKey = requireSessionKey(request?.sessionKey, 'session:plan:answer')
  if (typeof request.permissionId !== 'string' || request.permissionId === '') throw new Error("'session:plan:answer' requires a non-empty 'permissionId'")
  const decision: unknown = request.decision
  if (!isRecord(decision)) throw new Error("'session:plan:answer' requires a 'decision' object")
  if (decision['kind'] === 'approve') {
    if (decision['mode'] !== 'default' && decision['mode'] !== 'acceptEdits') {
      throw new Error("'session:plan:answer' requires an approve decision's 'mode' to be 'default' or 'acceptEdits'")
    }
    return deps.store.answerPlan(sessionKey, request.permissionId, decision as PlanDecision)
  }
  if (decision['kind'] === 'keep-planning') {
    const feedback = decision['feedback']
    if (typeof feedback !== 'string' || feedback.length < 1 || feedback.length > 2000) {
      throw new Error("'session:plan:answer' requires a keep-planning decision's 'feedback' to be 1-2000 characters")
    }
    return deps.store.answerPlan(sessionKey, request.permissionId, decision as PlanDecision)
  }
  throw new Error("'session:plan:answer' requires 'decision.kind' to be 'approve' or 'keep-planning'")
}
