import { stageModeFor } from '@/main/pipeline/transitions'
import type { StageLauncher, StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, HostedStore, SessionKey } from '@/types/hosting'
import type { RunStore } from '@/types/stage'
import { stageOfMode } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'
import { sessionSnapshot } from './session-snapshot'

/** A hosted store and a launcher whose sessions the test ends, joins or hands back. A launch records its run exactly as the real launcher does. */
export function scriptedStage(runs: RunStore, repoId: RepoId, now: () => Date) {
  const sessions = new Map<SessionKey, HostedSessionSnapshot>()
  const launches: StageLaunchRequest[] = []

  // Only what the dispatcher reads: the sessions, the room for another, and closing one.
  const store = {
    snapshotOf: (key: SessionKey) => sessions.get(key) ?? null,
    list: () => [...sessions.values()],
    capacity: () => Promise.resolve({ limit: 4, ceiling: 8 }),
    close: () => Promise.resolve({ ok: true as const }),
  } as unknown as HostedStore

  const launcher: StageLauncher = {
    launch: async (request) => {
      launches.push(request)
      const sessionKey = `hosted-${String(launches.length)}` as SessionKey
      sessions.set(sessionKey, sessionSnapshot({ sessionKey, repoId, phase: 'streaming' }))
      await runs.start(repoId, {
        id: `run-${String(launches.length)}`,
        stage: stageOfMode(stageModeFor(request.agent, request.trigger)),
        item: { kind: request.kind, number: request.number },
        agent: request.agent,
        trigger: request.trigger,
        model: request.model,
        title: request.title,
        sessionKey,
        claudeSessionId: 'sdk-1',
        worktree: { path: `/wt/${String(launches.length)}`, branch: null, baseSha: 'abc' },
        startedAt: now().toISOString(),
        endedAt: null,
        outcome: null,
        handback: null,
        costUsd: null,
        operatorJoinedAt: null,
        failure: null,
        interruption: null,
        networkRetries: 0,
        denials: [],
      })
      return { ok: true, sessionKey }
    },
  }

  return {
    store,
    launcher,
    launches,
    /** The session ends: its worktree stays, and nothing was handed back. */
    end: (key: SessionKey) => {
      const held = sessions.get(key)
      if (held !== undefined) sessions.set(key, { ...held, phase: 'ended' })
    },
    /** A completed hand-back as the launcher records it: the run ends with its outcome. */
    handBack: (key: SessionKey, outcome: StageOutcome) => {
      const held = sessions.get(key)
      if (held !== undefined) sessions.set(key, { ...held, phase: 'ended' })
      return runs.ended(repoId, `run-${key.slice('hosted-'.length)}`, outcome)
    },
  }
}
