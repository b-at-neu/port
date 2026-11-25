// The per-repository operator run state, kept in the `dispatch` section of the pipeline state file.
import { RUN_TARGET, type RepoRunState, type RunStateStore, type RunStateStoreStatus, type SetRunStateResult } from '@/types/dispatch'
import type { PipelineStateStore } from '@/types/pipeline-state'
import type { RepoId } from '@/utils/repos'

type Source = Pick<PipelineStateStore, 'ready' | 'status' | 'runStates' | 'writeRunStates'>

const pausedDefault = (repoId: RepoId): RepoRunState => ({ repoId, state: 'paused', since: null })

/** `unreadable`: while the file could not be read every repository reads paused, `run` and `drain` are refused, and `pause` needs no write. A missing file reads as no entries, never as open. */
export function createRunStateStore(source: Source, path: string): RunStateStore {
  let loaded = false
  // A `pause` or `drain` whose write failed still applies in memory; it fails toward dispatching less.
  const unwritten = new Map<RepoId, RepoRunState>()
  void source.ready.then(() => {
    loaded = true
  })

  function status(): RunStateStoreStatus {
    if (!loaded) return { kind: 'unread' }
    const current = source.status()
    return current.kind === 'loaded' ? { kind: 'loaded' } : { kind: 'unreadable', message: current.message, path }
  }

  function currentOf(repoId: RepoId): RepoRunState {
    const held = unwritten.get(repoId)
    if (held !== undefined) return held
    const entry = source.runStates()[repoId]
    return entry === undefined ? pausedDefault(repoId) : { repoId, state: entry.state, since: entry.since }
  }

  return {
    current: currentOf,
    status,
    snapshot: (repoIds) => ({ store: status(), repositories: repoIds.map(currentOf) }),
    path,

    async set(repoIds, state, at): Promise<SetRunStateResult> {
      const current = status()
      if (current.kind === 'unreadable') {
        if (state === 'paused') return { ok: true }
        return { ok: false, reason: 'unreadable', message: current.message }
      }
      const written = await source.writeRunStates({ ...source.runStates(), ...Object.fromEntries(repoIds.map((id) => [id, { state, since: at }])) })
      if (written.ok) {
        for (const id of repoIds) unwritten.delete(id)
        return { ok: true }
      }
      if (state !== RUN_TARGET.run) for (const id of repoIds) unwritten.set(id, { repoId: id, state, since: at })
      return { ok: false, reason: 'unwritable', message: written.message }
    },

    async forget(repoId): Promise<SetRunStateResult> {
      const current = status()
      if (current.kind === 'unreadable') return { ok: false, reason: 'unreadable', message: current.message }
      unwritten.delete(repoId)
      const { [repoId]: removed, ...rest } = source.runStates()
      if (removed === undefined) return { ok: true }
      const written = await source.writeRunStates(rest)
      return written.ok ? { ok: true } : { ok: false, reason: 'unwritable', message: written.message }
    },
  }
}
