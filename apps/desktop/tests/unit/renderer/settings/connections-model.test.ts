import { describe, expect, it } from 'vitest'
import { connectionOverview, connectionText } from '@/renderer/settings/connections-model'
import type { BoardSnapshot, RepositoryHealth } from '@/types/board'
import { initialHealth } from '@/types/board'
import type { GhStatus } from '@/types/gh'
import type { RuntimePreflight } from '@/types/runtime'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, repositoryState } from '../../../support/board-snapshot'

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
  it('reads the healthy case as one line per connection, all success, with ages only where one was read', () => {
    const lines = overview({ snapshot: snapshotWith({ lastSuccessAt: AGO_40S }) })
    expect(lines.map((line) => line.key)).toEqual(['claude-code', 'gh', 'github', `repo:${REPO}`])
    expect(lines.map((line) => line.tone)).toEqual(['success', 'success', 'success', 'success'])
    expect(lines.map((line) => line.age !== null)).toEqual([true, true, false, false])
    expect(connectionText(lines[0] as (typeof lines)[number])).toContain('2m ago')
  })

  it('never claims ready while a query is pending or failed', () => {
    const pending = overview({ preflight: { status: 'pending', data: undefined }, gh: { status: 'pending', data: undefined } })
    expect(pending.slice(0, 3).map((line) => line.tone)).toEqual(['idle', 'idle', 'idle'])
    const failed = overview({ preflight: { status: 'error', data: undefined }, gh: { status: 'error', data: undefined } })
    expect(failed.slice(0, 2).map((line) => [line.tone, line.age])).toEqual([
      ['idle', null],
      ['idle', null],
    ])
  })

  it.each([
    ['signed-out', 'danger'],
    ['missing', 'danger'],
  ] as const)('reads a %s gh as %s', (kind, tone) => {
    expect(overview({ gh: gh({ kind, checkedAt: AGO_40S }) })[1]?.tone).toBe(tone)
  })

  it('reads an unreadable gh as idle', () => {
    expect(overview({ gh: gh({ kind: 'unknown', message: 'boom', checkedAt: AGO_40S }) })[1]?.tone).toBe('idle')
  })

  it('names the account only when one could be parsed', () => {
    expect(overview({ gh: gh(SIGNED_IN) })[1]?.state).toContain('octo')
    expect(overview({ gh: gh({ kind: 'signed-in', checkedAt: AGO_40S, account: null, scopes: null }) })[1]?.state).not.toContain('octo')
  })

  it.each([
    ['cli-missing', 'danger'],
    ['unauthenticated', 'danger'],
    ['unverified', 'success'],
    ['verified', 'success'],
  ] as const)('reads a %s Claude Code as %s', (diagnosis, tone) => {
    expect(overview({ preflight: preflight({ diagnosis }) })[0]?.tone).toBe(tone)
  })

  it('warns below the rate-limit floor and names the reset time', () => {
    const resetAt = new Date(2026, 0, 1, 14, 5).toISOString()
    const line = overview({ snapshot: snapshotWith({ lastSuccessAt: AGO_40S }, { cost: 1, remaining: 150, resetAt, limit: 5000 }) })[2]
    expect(line?.tone).toBe('attention')
    expect(line?.state).toContain('14:05')
  })

  it('reads no repository read as idle', () => {
    expect(overview({ snapshot: snapshotWith({ lastSuccessAt: null }) })[2]?.tone).toBe('idle')
    expect(overview({ snapshot: boardSnapshot([]) })[2]?.tone).toBe('idle')
  })

  it('treats an unreadable rate limit as no reading, never zero points', () => {
    const line = overview({ snapshot: snapshotWith({ lastSuccessAt: AGO_40S }, { cost: 0, remaining: 0, resetAt: '', limit: 0 }) })[2]
    expect(line).toMatchObject({ tone: 'idle' })
    expect(line?.state).not.toContain('0 points')
  })

  it('flags a failing repository as attention with its last read age', () => {
    const line = overview({ snapshot: snapshotWith({ lastSuccessAt: '2026-01-01T11:54:00Z', consecutiveFailures: 2, lastError: 'rate limited' }) })[3]
    expect(line?.tone).toBe('attention')
    expect(line?.state).toContain('6m ago')
  })

  it('never reads a failing repository as idle, even with no read at all', () => {
    expect(overview({ snapshot: snapshotWith({ lastSuccessAt: null, consecutiveFailures: 1 }) })[3]?.tone).toBe('attention')
  })

  it('reads a never-read repository as idle', () => {
    expect(overview({ snapshot: snapshotWith({ lastSuccessAt: null }) })[3]?.tone).toBe('idle')
  })

  it('falls back to the repository id when no display name is known', () => {
    const lines = connectionOverview({ preflight: preflight(), gh: gh(SIGNED_IN), snapshot: snapshotWith({ lastSuccessAt: AGO_40S }), displayNames: {}, now: NOW })
    expect(lines[3]?.label).toBe(REPO)
  })
})
