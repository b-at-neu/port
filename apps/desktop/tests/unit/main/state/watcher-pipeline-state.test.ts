import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PipelineView, TrackedRef } from '@/types/pipeline-state'
import type { StateEngine } from '@/types/offload'
import type { PipelineState, RepositoryState } from '@/types/state'
import { createInProcessEngine } from '@/main/offload/engine'
import { createPipelineWatcher } from '@/main/state/watcher'
import { fakeGit, makeFakeTimer, readyEntry } from '../../../fixtures/watcher-harness'
import { reconciledItem, repositoryState } from '../../../fixtures/board-state'

const now = () => new Date('2026-01-01T00:00:00.000Z')
const TRACKED: TrackedRef[] = [{ kind: 'issue', number: 1, keys: ['marker', 'ready'] }]

async function rig(options: { readonly view: PipelineView; readonly state?: RepositoryState; readonly closed?: readonly number[]; readonly owner?: 'terminal' }) {
  const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
  const inner = createInProcessEngine({ now, git: fakeGit({ worktreeList: 0 }), sessionReader: () => Promise.resolve({ ok: true, sessions: [] }) })
  const log: string[] = []
  const projected: unknown[] = []
  const github: unknown[] = []
  const repoState = options.state ?? repositoryState([reconciledItem({ number: 1 })], { repoId: 'repo-a' as never })
  const engine: StateEngine = {
    ...inner,
    refreshGithub: (params) => {
      github.push(params)
      return Promise.resolve({ ok: true, at: 't', closed: options.closed })
    },
    project: (params) => {
      log.push('project')
      projected.push(params.views)
      const sessions = { ok: true as const, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' }
      return Promise.resolve({ repositories: [repoState], sessions, readAt: 't' } satisfies PipelineState)
    },
  }
  const seeded: string[] = []
  const pruned: unknown[] = []
  const watcher = createPipelineWatcher({
    repositories: [readyEntry('repo-a', root, 'o/a')],
    onSnapshot: () => undefined,
    now,
    setTimer: makeFakeTimer().factory,
    engine,
    dispatchStatus: () => (options.owner === undefined ? [] : [{ repoId: 'repo-a', owner: options.owner } as never]),
    pipelineView: () => options.view,
    trackedRefs: () => (options.view.kind === 'store' ? TRACKED : null),
    seedPipelineState: (repoId) => (seeded.push(`${String(repoId)}`), Promise.resolve()),
    prunePipelineState: (_repoId, closed) => (pruned.push(closed), Promise.resolve()),
    pipelineReady: () => (log.push('ready'), Promise.resolve()),
  })
  return { watcher, log, projected, github, seeded, pruned }
}

describe('createPipelineWatcher — pipeline state', () => {
  it('waits for the store to load before its first projection', async () => {
    const { watcher, log } = await rig({ view: { kind: 'labels' } })
    await watcher.refresh()
    watcher.stop()
    expect(log).toEqual(['ready', 'project'])
  })

  it('hands every repository its view to the projection and its tracked items to the GitHub read', async () => {
    const view: PipelineView = { kind: 'store', items: [] }
    const { watcher, projected, github } = await rig({ view })
    await watcher.refresh()
    watcher.stop()
    expect(projected).toEqual([{ 'repo-a': view }])
    expect(github[0]).toMatchObject({ tracked: TRACKED })
  })

  it('seeds a repository read by labels from the state just projected, once it is ok', async () => {
    const { watcher, seeded } = await rig({ view: { kind: 'labels' } })
    await watcher.refresh()
    watcher.stop()
    expect(seeded).toEqual(['repo-a'])
  })

  it('does not seed a repository already read from the store', async () => {
    const { watcher, seeded } = await rig({ view: { kind: 'store', items: [] } })
    await watcher.refresh()
    watcher.stop()
    expect(seeded).toEqual([])
  })

  it('does not seed a repository whose GitHub read failed', async () => {
    const failed: RepositoryState = { ok: false, repoId: 'repo-a' as never, repo: 'o/a', displayName: 'o/a', reason: 'github-unavailable', kind: 'network', message: 'offline', freshness: { github: { unavailable: 'offline' }, itemStates: { unavailable: 'x' }, sessions: { at: 't' }, worktrees: { at: 't' }, denials: { at: 't' } } }
    const { watcher, seeded } = await rig({ view: { kind: 'labels' }, state: failed })
    await watcher.refresh()
    watcher.stop()
    expect(seeded).toEqual([])
  })

  it('does not seed a repository the terminal cockpit holds, since its labels are the record', async () => {
    const { watcher, seeded } = await rig({ view: { kind: 'labels' }, owner: 'terminal' })
    await watcher.refresh()
    watcher.stop()
    expect(seeded).toEqual([])
  })

  it('prunes the items the GitHub read found closed', async () => {
    const { watcher, pruned } = await rig({ view: { kind: 'store', items: [] }, closed: [4, 5] })
    await watcher.refresh()
    watcher.stop()
    expect(pruned).toEqual([[4, 5]])
  })
})
