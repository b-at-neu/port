import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PipelineState, RepositoryState } from '@/types/state'
import type { Ticket } from '@/utils/pipeline/ticket'
import { createFakeGitHub, type FakeItem } from '../../../support/fake-github'
import { reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { AT } from '../../../support/state-store'
import { ticketOf } from '../../../support/tickets'
import { readyEntry, watcherRig } from '../../../fixtures/watcher-harness'

const REPO = 'repo-a' as RepoId
const SESSIONS = { ok: true as const, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: AT }
const FAILURE = { at: AT, outcome: { kind: 'item-unavailable' as const } }
const FAILED_TO_READ: RepositoryState = { ok: false, repoId: REPO, repo: 'o/a', displayName: 'o/a', reason: 'github-unavailable', kind: 'network', message: 'offline', freshness: { github: { unavailable: 'offline' }, itemStates: { unavailable: 'x' }, sessions: { at: AT }, worktrees: { at: AT }, denials: { at: AT } } }

interface RigOptions {
  /** Tickets the store already holds; none leaves the repository unseeded. */
  readonly tickets?: readonly Ticket[]
  readonly state?: RepositoryState
  readonly closed?: readonly number[]
  readonly merged?: readonly number[]
  readonly items?: readonly FakeItem[]
}

async function rig(options: RigOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
  const github = createFakeGitHub({ items: options.items ?? [{ number: 1, labels: ['port'], assignees: ['op'] }] })
  const projected: unknown[] = []
  const refreshed: unknown[] = []
  const state = options.state ?? repositoryState([reconciledItem({ number: 2 })], { repoId: REPO })
  const harness = watcherRig({
    repositories: [readyEntry(REPO, root, 'o/a')],
    platform: github.platform,
    ...(options.tickets === undefined ? {} : { tickets: { repoId: REPO, tickets: options.tickets } }),
    engine: {
      refreshGithub: (params) => {
        refreshed.push(params)
        return Promise.resolve({ ok: true, at: AT, closed: options.closed, merged: options.merged })
      },
      project: (params) => {
        projected.push(params.views)
        return Promise.resolve({ repositories: [state], sessions: SESSIONS, readAt: AT } satisfies PipelineState)
      },
    },
  })
  const store = harness.ctx.stores.pipelineState
  return { watcher: harness.watch(), store, github, projected, refreshed }
}

describe('createPipelineWatcher — pipeline state', () => {
  it('waits for the store to load before its first projection', async () => {
    const { watcher, projected, store } = await rig({ tickets: [ticketOf({ repo: REPO, ticket: 1 })] })
    await watcher.refresh()
    watcher.stop()
    expect(projected).toEqual([{ [REPO]: store.view(REPO) }])
    expect(store.view(REPO).kind).toBe('store')
  })

  it("hands the projection the repository's view and the GitHub read its tracked items", async () => {
    const { watcher, projected, refreshed, store } = await rig({ tickets: [ticketOf({ repo: REPO, ticket: 1 })] })
    await watcher.refresh()
    watcher.stop()
    expect(projected).toEqual([{ [REPO]: store.view(REPO) }])
    expect(refreshed[0]).toMatchObject({ tracked: store.tracked(REPO) })
  })

  it.each([
    { name: 'seeds an unseeded repository from the state just projected', options: {} satisfies RigOptions, seeded: [2] },
    { name: 'does not seed a repository already read from the store', options: { tickets: [ticketOf({ repo: REPO, ticket: 1 })] } satisfies RigOptions, seeded: [1] },
    { name: 'does not seed a repository whose GitHub read failed', options: { state: FAILED_TO_READ } satisfies RigOptions, seeded: [] },
  ])('$name', async ({ options, seeded }) => {
    const { watcher, store } = await rig(options)
    await watcher.refresh()
    watcher.stop()
    expect((store.tickets(REPO) ?? []).map((ticket) => ticket.ticket)).toEqual(seeded)
  })

  it.each([
    { name: 'prunes the items the GitHub read found closed', closed: [3], merged: undefined, left: [4] },
    { name: 'finishes a merged pull request, then prunes it with its issue', closed: [4, 5], merged: [5], left: [3] },
    { name: 'finishes nothing when the read found nothing closed', closed: [] as number[], merged: undefined, left: [3, 4] },
  ])('$name', async ({ closed, merged, left }) => {
    const tickets = [ticketOf({ repo: REPO, ticket: 3 }), ticketOf({ repo: REPO, ticket: 4, pr: { number: 5, approvedAt: null }, stage: 'merge', status: { kind: 'waiting-on-you', gate: 'merge', detail: '' } })]
    const items: FakeItem[] = [{ number: 3, labels: ['port'], assignees: ['op'] }, { number: 4, labels: ['port'], assignees: ['op'] }, { number: 5, kind: 'pull-request', labels: ['port'], assignees: ['op'], headRefName: '4-fix' }]
    const { watcher, store } = await rig({ tickets, closed, merged, items })
    await watcher.refresh()
    watcher.stop()
    expect((store.tickets(REPO) ?? []).map((ticket) => ticket.ticket).sort()).toEqual(left)
  })

  it('retries a failed mirror for a repository read from the store', async () => {
    const { watcher, store } = await rig({ tickets: [ticketOf({ repo: REPO, ticket: 1, mirror: { written: [], failure: FAILURE } })] })
    await watcher.refresh()
    await vi.waitFor(() => expect(store.ticket(REPO, { kind: 'issue', number: 1 })?.mirror.failure).toBeNull())
    watcher.stop()
  })

  it('never lets a failed retry reject the refresh', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { watcher, github } = await rig({ tickets: [ticketOf({ repo: REPO, ticket: 1, mirror: { written: [], failure: FAILURE } })] })
    github.failWrites(1, 'boom')
    await expect(watcher.refresh()).resolves.toBeDefined()
    watcher.stop()
    error.mockRestore()
  })
})
