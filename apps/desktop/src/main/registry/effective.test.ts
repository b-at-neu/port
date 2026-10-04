import { describe, expect, it } from 'vitest'
import { foldDispositions, fromShape, labelOverridesOf, parseExcusedCheckName, toShape } from './effective'
import type { PortResolved } from './effective'
import type { AppliedOverride } from '../../shared/repos'

const BASE: PortResolved = {
  branches: { integration: 'dev', production: 'main' },
  models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
  modules: { approvalGate: true, release: true, scope: true },
  reviewCycleCap: 5,
  concurrency: { sharedFiles: [], overlapThreshold: 2 },
  sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
}

function override(path: string, value: AppliedOverride['value']): AppliedOverride {
  return { path, value, reason: 'test', portDefault: undefined, source: 'CLAUDE.md' }
}

describe('toShape', () => {
  it('maps a non-blank raw label to its own name, and a blank or absent one to the default', () => {
    const shape = toShape(BASE, { ready: 'go', blocked: '  ', planning: 42 })
    expect(shape.labels.ready).toBe('go')
    expect(shape.labels.blocked).toBe('blocked')
    expect(shape.labels.planning).toBe('planning')
  })

  it('carries branches, models, modules, reviewCycleCap, concurrency, and sessionRequiredPaths straight through', () => {
    const shape = toShape(BASE, {})
    expect(shape.integration).toBe('dev')
    expect(shape.production).toBe('main')
    expect(shape.models).toEqual(BASE.models)
    expect(shape.modules).toEqual(BASE.modules)
    expect(shape.reviewCycleCap).toBe(5)
    expect(shape.concurrency).toEqual({ sharedFiles: [], overlapThreshold: 2 })
    expect(shape.sessionRequiredPaths).toEqual(['CLAUDE.md', '.claude/**'])
  })
})

describe('fromShape', () => {
  it('is the inverse of toShape for the fields ResolvedRepoConfig carries', () => {
    const shape = toShape(BASE, {})
    expect(fromShape(shape)).toEqual({
      branches: { integration: 'dev', production: 'main' },
      models: BASE.models,
      modules: BASE.modules,
      reviewCycleCap: 5,
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
    })
  })

  it('carries a null production through, single-branch mode', () => {
    const shape = toShape({ ...BASE, branches: { integration: 'dev', production: null } }, {})
    expect(fromShape(shape).branches).toEqual({ integration: 'dev', production: null })
  })
})

describe('labelOverridesOf', () => {
  it('extracts only the labels.<key> entries, by their key', () => {
    const applied = [override('labels.ready', 'go'), override('reviewCycleCap', 3)]
    expect(labelOverridesOf(applied)).toEqual({ ready: 'go' })
  })

  it('ignores a labels.<key> entry naming a key outside the vocabulary', () => {
    const applied = [override('labels.notARealKey', 'x')]
    expect(labelOverridesOf(applied)).toEqual({})
  })

  it('returns {} for no label overrides', () => {
    expect(labelOverridesOf([])).toEqual({})
  })
})

describe('foldDispositions', () => {
  it('folds the approval-gate excusal in first, as source approval-gate', () => {
    expect(foldDispositions('build', [])).toEqual({ build: { disposition: 'infrastructure', source: 'approval-gate' } })
  })

  it('folds each applied checks.<name> entry, as source CLAUDE.md', () => {
    const applied = [override('checks.deploy-preview', 'infrastructure')]
    expect(foldDispositions(null, applied)).toEqual({ 'deploy-preview': { disposition: 'infrastructure', source: 'CLAUDE.md' } })
  })

  it('a later CLAUDE.md entry overwrites the approval-gate name', () => {
    const applied = [override('checks.build', 'blocking')]
    expect(foldDispositions('build', applied)).toEqual({ build: { disposition: 'blocking', source: 'CLAUDE.md' } })
  })

  it('ignores a non-disposition checks.* value', () => {
    const applied = [override('checks.build', 'nonsense')]
    expect(foldDispositions(null, applied)).toEqual({})
  })
})

describe('parseExcusedCheckName', () => {
  it('reads the single job key under jobs:', () => {
    const text = 'name: approval gate\non: pull_request\njobs:\n  approval-check:\n    runs-on: ubuntu-latest\n'
    expect(parseExcusedCheckName(text)).toBe('approval-check')
  })

  it('returns null when there is no jobs: section', () => {
    expect(parseExcusedCheckName('name: approval gate\n')).toBeNull()
  })
})
