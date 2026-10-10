import { describe, expect, it } from 'vitest'
import { resolveVocabulary, verifyVocabulary } from '../../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../../shared/labels/vocabulary'
import type { BoardSnapshot, RepositoryHealth } from '../../../shared/board/types'
import { DEFAULT_POLL_POLICY, initialHealth } from '../../../shared/board/types'
import type { RepoId, ResolvedRepoConfig } from '../../../shared/repos'
import type { RepositoryState } from '../../../shared/state/types'
import { overviewHealth } from './health-model'

const REPO_ID = 'repo-gadgets' as RepoId
const NOW = new Date('2026-01-01T00:00:00.000Z')

function config(vocabulary: LabelVocabulary, overrides: ResolvedRepoConfig['overrides'] = []): ResolvedRepoConfig {
  return {
    repo: 'acme/gadgets',
    owner: 'acme',
    name: 'gadgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: false, scope: true },
    reviewCycleCap: 3,
    vocabulary,
    commands: { worktrees: 'node w.mjs', budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides,
  }
}

function health(): RepositoryHealth {
  return { repoId: REPO_ID, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials') }
}

function readyState(vocabulary: LabelVocabulary, verdict: ReturnType<typeof verifyVocabulary>): RepositoryState {
  return {
    ok: true,
    repoId: REPO_ID,
    repo: 'acme/gadgets',
    displayName: 'acme/gadgets',
    items: [],
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/x/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: verdict,
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4987, resetAt: '2026-01-01T01:00:00.000Z' },
    freshness: {
      github: { at: NOW.toISOString() },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
      itemStates: { at: NOW.toISOString() },
    },
    worktreeTotals: null,
    viewer: 'octo-dev',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 3,
  }
}

function snapshotWith(state: RepositoryState | null): BoardSnapshot | undefined {
  if (state === null) return undefined
  return {
    state: { repositories: [state], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 1, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() },
    health: [health()],
    policy: DEFAULT_POLL_POLICY,
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
  }
}

describe('overviewHealth', () => {
  it('reports mis-resolved plus a CLAUDE.md override row for a repo with no vocabulary label at all', () => {
    const vocabulary = resolveVocabulary({ modules: { approvalGate: true, release: false, scope: true }, overrides: { ready: 'queued' } })
    const verdict = verifyVocabulary(vocabulary, { ok: true, names: [] })
    const overrides: ResolvedRepoConfig['overrides'] = [{ path: 'labels.ready', value: 'queued', reason: 'CLAUDE.md port-overrides', portDefault: 'ready', source: 'CLAUDE.md' }]
    const cfg = config(vocabulary, overrides)
    const snapshot = snapshotWith(readyState(vocabulary, verdict))

    const result = overviewHealth(cfg, REPO_ID, snapshot)

    expect(result.labels).not.toBeNull()
    expect(result.labels?.verdict).toBe('mis-resolved')
    const readyRow = result.labels?.rows.find((r) => r.key === 'ready')
    expect(readyRow?.source).toBe('CLAUDE.md')
    expect(readyRow?.present).toBe(false)
    expect(result.overrides).toEqual(overrides)
  })

  it('gives labels and sources as null for a repository missing from the snapshot', () => {
    const vocabulary = resolveVocabulary({ modules: { approvalGate: true, release: false, scope: true } })
    const cfg = config(vocabulary)
    const result = overviewHealth(cfg, REPO_ID, undefined)

    expect(result.labels).toBeNull()
    expect(result.sources).toBeNull()
    expect(result.rateLimit).toBeNull()
  })

  it('reports modules in a fixed order, each as its own flag', () => {
    const vocabulary = resolveVocabulary({ modules: { approvalGate: true, release: false, scope: true } })
    const cfg = config(vocabulary)
    const result = overviewHealth(cfg, REPO_ID, undefined)
    expect(result.modules).toEqual([
      { name: 'approvalGate', on: true },
      { name: 'release', on: false },
      { name: 'scope', on: true },
    ])
  })

  it('sets present to null for every row when the verdict is unverified', () => {
    const vocabulary = resolveVocabulary({ modules: { approvalGate: true, release: false, scope: true } })
    const verdict = verifyVocabulary(vocabulary, { ok: false, reason: 'rate limited' })
    const cfg = config(vocabulary)
    const snapshot = snapshotWith(readyState(vocabulary, verdict))
    const result = overviewHealth(cfg, REPO_ID, snapshot)
    expect(result.labels?.verdict).toBe('unverified')
    expect(result.labels?.rows.every((r) => r.present === null)).toBe(true)
  })
})
