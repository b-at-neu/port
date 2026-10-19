import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageTag } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'

interface StageSessionOptions {
  readonly key?: string
  readonly repoId: RepoId
  readonly stage: StageTag
  readonly phase?: HostedSessionSnapshot['phase']
  readonly startedAt?: string
  readonly lastResult?: HostedSessionSnapshot['lastResult']
}

/** A hosted stage session with every unrelated field at its idle default. */
export function stageSession(options: StageSessionOptions): HostedSessionSnapshot {
  return {
    sessionKey: (options.key ?? `hosted-${String(options.stage.number)}`) as SessionKey,
    claudeSessionId: 's1',
    repoId: options.repoId,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: options.phase ?? 'streaming',
    origin: { kind: 'fresh' },
    startedAt: options.startedAt ?? '2026-01-01T00:00:00.000Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: null,
    rateLimit: null,
    controls: { permissionMode: 'default', model: null, effort: null },
    models: { kind: 'pending' },
    usage: null,
    stage: options.stage,
    lastResult: options.lastResult ?? null,
    backgroundTasks: [],
    operatorJoinedAt: null,
  }
}
