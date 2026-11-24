import { describe, expect, it } from 'vitest'
import { addResultToast, denialsRegion, isDenialsEmpty, registryReason, removeResultToast, repoLookup } from '@/renderer/repositories/model'
import type { RegistryFailureKind, ReposAddResponse, ReposListResponse } from '@/types/ipc'
import type { DenialsRead, DenialSummary } from '@/types/local'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, repositoryState } from '../../../support/board-snapshot'
import { readyEntry } from '../../../support/repo-config'

const FOUND = readyEntry()
const OTHER = readyEntry({ id: 'repo-b' as RepoId })
const LISTED: ReposListResponse = { ok: true, repositories: [OTHER, FOUND] }
const FAILED: ReposListResponse = { ok: false, kind: 'registry-malformed', message: 'bad json' }

describe('repoLookup', () => {
  it.each([
    ['still pending', { data: undefined, status: 'pending' }, 'loading', null],
    ['rejected with nothing in hand', { data: undefined, status: 'error' }, 'error', null],
    ['a typed registry failure', { data: FAILED, status: 'success' }, 'ready', 'registry-malformed'],
    ['an id that is not registered', { data: { ok: true, repositories: [OTHER] }, status: 'success' }, 'empty', null],
    ['a registered id', { data: LISTED, status: 'success' }, 'ready', null],
    ['stale data under a later rejection', { data: LISTED, status: 'error' }, 'ready', null],
  ] as const)('reads %s', (_label, query, state, failure) => {
    expect(repoLookup(query, 'repo-a')).toMatchObject({ state, failure })
  })

  it('returns the matching entry', () => {
    expect(repoLookup({ data: LISTED, status: 'success' }, 'repo-a').entry).toBe(FOUND)
  })
})

describe('registryReason', () => {
  it.each([
    ['registry-malformed', 'malformed'],
    ['registry-unsupported-version', 'unsupported-version'],
    ['registry-unreadable', 'unreadable'],
    ['registry-unwritable', 'unreadable'],
  ] as const satisfies readonly (readonly [RegistryFailureKind, string])[])('maps %s to %s', (kind, reason) => {
    expect(registryReason(kind)).toBe(reason)
  })
})

describe('addResultToast', () => {
  const added = 'repo-a' as RepoId
  it.each([
    ['added', { ok: true, outcome: 'added', added, repositories: [FOUND] }, 'success'],
    ['already registered', { ok: true, outcome: 'already-registered', existing: added, repositories: [FOUND] }, 'info'],
    ['cancelled', { ok: true, outcome: 'cancelled' }, null],
    ['a registry failure', { ok: false, kind: 'registry-unwritable', message: 'EACCES' }, 'error'],
  ] as const satisfies readonly (readonly [string, ReposAddResponse, string | null])[])('maps %s', (_label, result, tone) => {
    expect(addResultToast(result)?.tone ?? null).toBe(tone)
  })
})

describe('removeResultToast', () => {
  it.each([
    ['removed', { ok: true, repositories: [] }, 'success'],
    ['refused', { ok: false, kind: 'not-registered', message: 'gone' }, 'error'],
  ] as const)('maps %s', (_label, result, tone) => {
    expect(removeResultToast('o/a', result).tone).toBe(tone)
  })
})

const EMPTY_SUMMARY: DenialSummary = { agentDenials: 0, railDenials: 0, misses: 0, gateClears: 0, hookErrors: 0, legacy: 0, malformed: 0, total: 0 }
const AT = '2026-01-01T00:00:00Z'

function snapshotWithDenials(denials: DenialsRead) {
  return boardSnapshot([repositoryState([], { denials })])
}

describe('denialsRegion and isDenialsEmpty', () => {
  it('is null for a repository missing from the snapshot', () => {
    expect(denialsRegion(boardSnapshot([]), 'repo-a' as RepoId)).toBeNull()
  })

  it.each([
    ['a repository missing from the snapshot', null, true],
    ['a log that is not present', { ok: true, present: false, path: '/p', readAt: AT }, true],
    ['a log with no analysed entries', { ok: true, present: true, path: '/p', entries: [], summary: EMPTY_SUMMARY, capped: false, readAt: AT }, true],
    ['a failed read', { ok: false, kind: 'io', message: 'EIO', path: '/p', readAt: AT }, false],
    [
      'a log with an entry',
      { ok: true, present: true, path: '/p', entries: [{ raw: 'r', form: 'current', timestamp: AT, decision: 'deny', actor: { kind: 'unattributed', raw: 'x' }, subject: 'git push' }], summary: { ...EMPTY_SUMMARY, total: 1 }, capped: false, readAt: AT },
      false,
    ],
  ] as const)('judges %s', (_label, read, empty) => {
    const inspection = read === null ? null : denialsRegion(snapshotWithDenials(read), 'repo-a' as RepoId)
    expect(isDenialsEmpty(inspection)).toBe(empty)
  })
})
