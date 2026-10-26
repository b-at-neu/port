import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { BoardSnapshot } from '@/types/board'
import { createPipelineWatcher } from '@/main/state/watcher'
import { RATE_LIMIT_REPLY } from '../../../fixtures/pipeline-reply'
import { fakeGit, makeFakeTimer, readyEntry, readyItemGh } from '../../../fixtures/watcher-harness'

const AUTO_PLAN_LABELS = ['claude', 'auto plan', 'plan review']

function dispatchRow(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: 'repo-a' as RepoId, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

async function build(options: { readonly dispatch: () => readonly RepoDispatchStatus[]; readonly refused?: () => ReadonlySet<number> }) {
  const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
  const snapshots: BoardSnapshot[] = []
  const watcher = createPipelineWatcher({
    repositories: [readyEntry('repo-a', root, 'o/a')],
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    setTimer: makeFakeTimer().factory,
    git: fakeGit({ worktreeList: 0 }),
    gh: readyItemGh('op', ['op'], RATE_LIMIT_REPLY, AUTO_PLAN_LABELS),
    sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    dispatchStatus: options.dispatch,
    autoPlanRefused: options.refused,
  })
  return { watcher, snapshots }
}

describe('createPipelineWatcher — auto-plan status', () => {
  it('lists the issue the swap will approve under its repository', async () => {
    const { watcher } = await build({ dispatch: () => [dispatchRow()] })
    const snap = await watcher.refresh()
    expect(snap.autoPlan).toEqual([{ repoId: 'repo-a', approving: [42] }])
  })

  it('leaves a refused issue out', async () => {
    const { watcher } = await build({ dispatch: () => [dispatchRow()], refused: () => new Set([42]) })
    const snap = await watcher.refresh()
    expect(snap.autoPlan).toEqual([{ repoId: 'repo-a', approving: [] }])
  })

  it('republish() recomputes the list from the fresh dispatch row without a poll', async () => {
    let row = dispatchRow()
    const { watcher, snapshots } = await build({ dispatch: () => [row] })
    await watcher.refresh()
    row = dispatchRow({ runState: 'paused' })
    watcher.republish()
    expect(snapshots.at(-1)?.autoPlan).toEqual([{ repoId: 'repo-a', approving: [] }])
  })

  it('starts empty before the first poll', async () => {
    const { watcher } = await build({ dispatch: () => [dispatchRow()] })
    expect(watcher.snapshot().autoPlan).toEqual([])
  })
})
