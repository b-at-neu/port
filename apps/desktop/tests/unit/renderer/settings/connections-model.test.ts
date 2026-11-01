import { describe, expect, it } from 'vitest'
import { connectionOverview, connectionText } from '@/renderer/settings/connections-model'
import type { BoardSnapshot, RepositoryHealth } from '@/types/board'
import { initialHealth } from '@/types/board'
import type { GhStatus } from '@/types/gh'
import type { RuntimePreflight } from '@/types/runtime'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, repositoryState } from '../../../fixtures/board-state'

const NOW = new Date('2026-01-01T12:00:00Z')
const AGO_2M = '2026-01-01T11:58:00Z'
const AGO_40S = '2026-01-01T11:59:20Z'
const REPO = 'repo-a' as RepoId

function preflight(overrides: Partial<RuntimePreflight> = {}) {
  return { status: 'success' as const, data: { checkedAt: AGO_2M, executable: null, version: null, credentials: null, apiKeyInEnvironment: false, diagnosis: 'unverified', detail: null, ...overrides } satisfies RuntimePreflight }
}

function gh(data: GhStatus) {
  return { status: 'success' as const, data }
}

const SIGNED_IN: GhStatus = { kind: 'signed-in', checkedAt: AGO_40S, account: 'octo', scopes: ['repo'] }

function snapshotWith(health: Partial<RepositoryHealth['github']>, rateLimit = { cost: 1, remaining: 4812, resetAt: '2026-01-01T12:30:00Z', limit: 5000 }): BoardSnapshot {
  const base = boardSnapshot([repositoryState([], { repoId: REPO, rateLimit })])
  return { ...base, health: [{ repoId: REPO, github: { ...initialHealth('github'), ...health }, sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials') }] }
}

function overview(params: { preflight?: ReturnType<typeof preflight> | { status: 'pending'; data: undefined } | { status: 'error'; data: undefined }; gh?: ReturnType<typeof gh> | { status: 'pending'; data: undefined } | { status: 'error'; data: undefined }; snapshot?: BoardSnapshot }) {
  return connectionOverview({
    preflight: params.preflight ?? preflight(),
    gh: params.gh ?? gh(SIGNED_IN),
    snapshot: params.snapshot,
    displayNames: { [REPO]: 'acme/widgets' },
    now: NOW,
  })
}

describe('connectionOverview', () => {
  it('reads the healthy case as one line per connection with its age', () => {
    const lines = overview({ snapshot: snapshotWith({ lastSuccessAt: AGO_40S }) })
    expect(lines.map(connectionText)).toEqual([
      'Claude Code · ready · checked 2m ago',
      'gh · signed in as octo · checked just now',
      'GitHub · 4,812 points left',
      'acme/widgets · read just now',
    ])
    expect(lines.map((line) => line.tone)).toEqual(['success', 'success', 'success', 'success'])
  })

  it('never claims ready while a query is pending or failed', () => {
    const pending = overview({ preflight: { status: 'pending', data: undefined }, gh: { status: 'pending', data: undefined } })
    expect(pending[0]).toMatchObject({ state: 'checking…', tone: 'idle' })
    expect(pending[1]).toMatchObject({ state: 'checking…', tone: 'idle' })
    expect(pending[2]).toMatchObject({ state: 'checking…', tone: 'idle' })
    const failed = overview({ preflight: { status: 'error', data: undefined }, gh: { status: 'error', data: undefined } })
    expect(failed[0]).toMatchObject({ state: "couldn't check", tone: 'idle' })
    expect(failed[1]).toMatchObject({ state: "couldn't check", tone: 'idle' })
  })

  it('reads a signed-out gh as danger', () => {
    const line = overview({ gh: gh({ kind: 'signed-out', checkedAt: AGO_40S }) })[1]
    expect(line).toMatchObject({ state: 'signed out', tone: 'danger' })
  })

  it('reads a missing gh as not installed, and an unreadable one as idle', () => {
    expect(overview({ gh: gh({ kind: 'missing', checkedAt: AGO_40S }) })[1]).toMatchObject({ state: 'not installed', tone: 'danger' })
    expect(overview({ gh: gh({ kind: 'unknown', message: 'boom', checkedAt: AGO_40S }) })[1]).toMatchObject({ state: "couldn't check", tone: 'idle' })
  })

  it('keeps signed in without an account when none could be parsed', () => {
    expect(overview({ gh: gh({ kind: 'signed-in', checkedAt: AGO_40S, account: null, scopes: null }) })[1]?.state).toBe('signed in')
  })

  it('reads a missing or broken Claude Code as danger, an unverified one as ready', () => {
    expect(overview({ preflight: preflight({ diagnosis: 'cli-missing' }) })[0]).toMatchObject({ state: 'not installed', tone: 'danger' })
    expect(overview({ preflight: preflight({ diagnosis: 'unauthenticated' }) })[0]).toMatchObject({ state: 'not ready', tone: 'danger' })
    expect(overview({ preflight: preflight({ diagnosis: 'verified' }) })[0]).toMatchObject({ state: 'ready', tone: 'success' })
  })

  it('warns below the rate-limit floor and names the reset time', () => {
    const resetAt = new Date(2026, 0, 1, 14, 5).toISOString()
    const line = overview({ snapshot: snapshotWith({ lastSuccessAt: AGO_40S }, { cost: 1, remaining: 150, resetAt, limit: 5000 }) })[2]
    expect(line).toMatchObject({ state: '150 points left · resets 14:05', tone: 'attention' })
  })

  it('says no read yet, at idle, when no repository has been read', () => {
    expect(overview({ snapshot: snapshotWith({ lastSuccessAt: null }) })[2]).toMatchObject({ state: 'no read yet', tone: 'idle' })
    expect(overview({ snapshot: boardSnapshot([]) })[2]).toMatchObject({ state: 'no read yet', tone: 'idle' })
  })

  it('treats an unreadable rate limit as no reading, never zero points', () => {
    const line = overview({ snapshot: snapshotWith({ lastSuccessAt: AGO_40S }, { cost: 0, remaining: 0, resetAt: '', limit: 0 }) })[2]
    expect(line?.state).toBe('no read yet')
  })

  it('flags a failing repository as attention with its last read age', () => {
    const line = overview({ snapshot: snapshotWith({ lastSuccessAt: '2026-01-01T11:54:00Z', consecutiveFailures: 2, lastError: 'rate limited' }) })[3]
    expect(line).toMatchObject({ state: 'last read 6m ago · failing', tone: 'attention' })
  })

  it('never reads a failing repository as idle, even with no read at all', () => {
    expect(overview({ snapshot: snapshotWith({ lastSuccessAt: null, consecutiveFailures: 1 }) })[3]).toMatchObject({ state: 'never read · failing', tone: 'attention' })
  })

  it('reads a never-read repository as idle', () => {
    expect(overview({ snapshot: snapshotWith({ lastSuccessAt: null }) })[3]).toMatchObject({ state: 'never read', tone: 'idle' })
  })

  it('falls back to the repository id when no display name is known', () => {
    const lines = connectionOverview({ preflight: preflight(), gh: gh(SIGNED_IN), snapshot: snapshotWith({ lastSuccessAt: AGO_40S }), displayNames: {}, now: NOW })
    expect(lines[3]?.label).toBe(REPO)
  })
})
