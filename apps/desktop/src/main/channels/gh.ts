// `'gh:status'`'s composition — the footer's status dot. This file never
// throws for a gh failure itself; every outcome is a value.
import type { GhStatus } from '../../shared/gh/types'
import type { IpcMap } from '../../shared/ipc'
import { ghAuthStatus } from '../platform/gh'
import type { GhAuthStatusResult } from '../platform/gh'

export interface GhStatusDeps {
  readonly ghAuthStatus: typeof ghAuthStatus
  readonly now: () => number
}

export const defaultGhStatusDeps: GhStatusDeps = { ghAuthStatus, now: () => Date.now() }

// Every failure branch `ghAuthStatus` can still return once 'not-found' and
// the authenticated/unauthenticated reads are handled separately below.
function messageFor(result: Exclude<GhAuthStatusResult, { ok: true } | { ok: false; kind: 'not-found' }>): string {
  switch (result.kind) {
    case 'cwd-missing':
      return `working directory not found: ${result.cwd}`
    case 'signalled':
      return `gh was terminated by signal ${result.signal}`
    case 'timeout':
      return `gh timed out after ${String(result.timeoutMs)}ms`
    case 'output-too-large':
      return 'gh produced more output than this app will buffer'
    case 'spawn-failed':
      return result.message
    // `ghAuthStatus` never classifies through `classifyGhExit`, so these can
    // never actually occur — handled only because the type is shared.
    case 'rate-limited':
    case 'forbidden':
    case 'http-not-found':
    case 'network':
    case 'unknown':
      return result.stderr !== '' ? result.stderr : `gh reported ${result.kind}`
    default:
      return `gh reported ${(result as { kind: string }).kind}`
  }
}

export async function resolveGhStatus(request: IpcMap['gh:status']['request'], deps: GhStatusDeps = defaultGhStatusDeps): Promise<GhStatus> {
  if (request !== undefined) throw new Error("'gh:status' takes no payload")
  const checkedAt = new Date(deps.now()).toISOString()
  const result = await deps.ghAuthStatus({ timeoutMs: 8_000 })
  if (result.ok) return result.authenticated ? { kind: 'signed-in', checkedAt } : { kind: 'signed-out', checkedAt }
  if (result.kind === 'not-found') return { kind: 'missing', checkedAt }
  return { kind: 'unknown', message: messageFor(result), checkedAt }
}
