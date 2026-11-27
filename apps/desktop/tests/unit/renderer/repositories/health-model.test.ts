import { describe, expect, it } from 'vitest'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { verifyVocabulary } from '@/utils/labels/vocabulary'
import { initialHealth } from '@/types/board'
import type { RepoId, ResolvedRepoConfig } from '@/utils/repos'
import { overviewHealth } from '@/renderer/repositories/health-model'
import { boardSnapshot, repositoryState } from '../../../support/board-snapshot'
import { repoConfig } from '../../../support/repo-config'

const REPO_ID = 'repo-a' as RepoId
const MODULES = { approvalGate: true, release: false, scope: true }

function config(overrides: Partial<ResolvedRepoConfig> = {}): ResolvedRepoConfig {
  return repoConfig({ modules: MODULES, ...overrides })
}

function snapshotWith(verdict: ReturnType<typeof verifyVocabulary>) {
  const health = { repoId: REPO_ID, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials') }
  return boardSnapshot([repositoryState([], { vocabulary: verdict })], undefined, { health: [health] })
}

describe('overviewHealth', () => {
  it('reports mis-resolved plus a CLAUDE.md override row for a repo with no display label at all', () => {
    const displayVocabulary = resolveDisplayVocabulary({ overrides: { planning: 'thinking' } })
    const verdict = verifyVocabulary(displayVocabulary, { ok: true, names: [] })
    const overrides: ResolvedRepoConfig['overrides'] = [{ path: 'states.planning', value: 'thinking', reason: 'CLAUDE.md port-overrides', portDefault: 'planning', source: 'CLAUDE.md' }]
    const result = overviewHealth(config({ overrides, displayVocabulary }), REPO_ID, snapshotWith(verdict))

    expect(result.labels?.verdict).toBe('mis-resolved')
    const planningRow = result.labels?.rows.find((r) => r.key === 'planning')
    expect(planningRow?.source).toBe('CLAUDE.md')
    expect(planningRow?.present).toBe(false)
    expect(result.overrides).toEqual(overrides)
  })

  it('gives labels and sources as null for a repository missing from the snapshot', () => {
    const result = overviewHealth(config(), REPO_ID, undefined)

    expect(result.labels).toBeNull()
    expect(result.sources).toBeNull()
    expect(result.rateLimit).toBeNull()
  })

  it('reports modules in a fixed order, each as its own flag', () => {
    const result = overviewHealth(config(), REPO_ID, undefined)
    expect(result.modules).toEqual([
      { name: 'approvalGate', on: true },
      { name: 'release', on: false },
      { name: 'scope', on: true },
    ])
  })

  it('lists the seven display labels, checked against the display vocabulary', () => {
    const displayVocabulary = resolveDisplayVocabulary({ states: { implementing: 'Building' } })
    const verdict = verifyVocabulary(displayVocabulary, { ok: true, names: ['port', 'needs you', 'planning'] })
    const result = overviewHealth(config({ displayVocabulary }), REPO_ID, snapshotWith(verdict))

    expect(result.labels?.rows.map((r) => [r.name, r.present])).toEqual([
      ['port', true],
      ['needs you', true],
      ['planning', true],
      ['Building', false],
      ['reviewing', false],
      ['revising', false],
      ['approved', false],
    ])
  })

  it('sets present to null for every row when the verdict is unverified', () => {
    const verdict = verifyVocabulary(resolveDisplayVocabulary({}), { ok: false, reason: 'rate limited' })
    const result = overviewHealth(config(), REPO_ID, snapshotWith(verdict))
    expect(result.labels?.verdict).toBe('unverified')
    expect(result.labels?.rows.every((r) => r.present === null)).toBe(true)
  })
})
