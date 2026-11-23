import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageTag } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'

/** A hosted session with every field at its idle default. */
export function sessionSnapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: 'repo-a' as RepoId,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending' },
    title: null,
    rateLimit: null,
    controls: { permissionMode: 'default', model: null, effort: null },
    models: { kind: 'pending' },
    usage: null,
    backgroundTasks: [],
    stage: null,
    lastResult: null,
    operatorJoinedAt: null,
    ...overrides,
  }
}

interface StageSessionOptions {
  readonly key?: string
  readonly repoId: RepoId
  readonly stage: StageTag
  readonly phase?: HostedSessionSnapshot['phase']
  readonly startedAt?: string
  readonly lastResult?: HostedSessionSnapshot['lastResult']
  readonly pendingPermissions?: HostedSessionSnapshot['pendingPermissions']
}

/** A hosted session running the given pipeline stage. */
export function stageSession(options: StageSessionOptions): HostedSessionSnapshot {
  return sessionSnapshot({
    sessionKey: (options.key ?? `hosted-${String(options.stage.number)}`) as SessionKey,
    claudeSessionId: 's1',
    repoId: options.repoId,
    phase: options.phase ?? 'streaming',
    startedAt: options.startedAt ?? '2026-01-01T00:00:00.000Z',
    pendingPermissions: options.pendingPermissions ?? [],
    stage: options.stage,
    lastResult: options.lastResult ?? null,
  })
}
