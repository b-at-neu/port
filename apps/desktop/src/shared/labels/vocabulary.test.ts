import { describe, expect, it } from 'vitest'
import template from '../../../../../plugins/port/templates/labels.json'
import { LABEL_DEFAULTS } from './defaults'
import { LABEL_KEYS, labelName, resolveVocabulary, verifyVocabulary, type RepoLabels } from './vocabulary'

// --- Anti-drift invariant: LABEL_KEYS and the template agree both directions,
// and every LABEL_DEFAULTS entry matches the template's name/module for that
// key. Imported with the same relative specifier as the source files rather
// than re-read through node:fs, so there is no path construction to get
// wrong on Windows.
describe('LABEL_KEYS / LABEL_DEFAULTS match the shipped template', () => {
  const templateKeys = template.labels.map((l) => l.key)

  it('has every template key in LABEL_KEYS', () => {
    for (const key of templateKeys) {
      expect(LABEL_KEYS).toContain(key)
    }
  })

  it('has no LABEL_KEYS entry absent from the template', () => {
    for (const key of LABEL_KEYS) {
      expect(templateKeys).toContain(key)
    }
  })

  it("has every LABEL_DEFAULTS entry's name and module equal to the template's", () => {
    const byKey = new Map(template.labels.map((l) => [l.key, l]))
    expect(LABEL_DEFAULTS.length).toBe(template.labels.length)
    for (const def of LABEL_DEFAULTS) {
      const t = byKey.get(def.key)
      expect(t).toBeDefined()
      expect(def.name).toBe(t?.name)
      expect(def.module).toBe(t?.module)
    }
  })
})

describe('resolveVocabulary', () => {
  it('resolves every default when labels is empty (acceptance case 1)', () => {
    const vocabulary = resolveVocabulary({ labels: {} })
    expect(vocabulary.problems).toEqual([])
    expect(vocabulary.labels).toHaveLength(LABEL_DEFAULTS.filter((d) => d.module === 'core').length)
    for (const label of vocabulary.labels) {
      expect(label.source).toBe('default')
    }
  })

  it('moves only the overridden key on a partial override (acceptance case 2)', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'todo' } })
    const ready = vocabulary.labels.find((l) => l.key === 'ready')
    expect(ready?.name).toBe('todo')
    expect(ready?.source).toBe('config')

    for (const label of vocabulary.labels) {
      if (label.key === 'ready') continue
      expect(label.source).toBe('default')
    }
  })

  it('omits exactly refreshBranch/refreshing when previewDatabase is off', () => {
    const vocabulary = resolveVocabulary({ labels: {}, modules: { previewDatabase: false } })
    expect([...vocabulary.disabled].sort()).toEqual(['refreshBranch', 'refreshing'])
    expect(vocabulary.labels.some((l) => l.key === 'refreshBranch')).toBe(false)
    expect(vocabulary.labels.some((l) => l.key === 'refreshing')).toBe(false)
  })

  it('includes refreshBranch/refreshing when previewDatabase is on', () => {
    const vocabulary = resolveVocabulary({ labels: {}, modules: { previewDatabase: true } })
    expect(vocabulary.disabled).toEqual([])
    expect(vocabulary.labels.some((l) => l.key === 'refreshBranch')).toBe(true)
    expect(vocabulary.labels.some((l) => l.key === 'refreshing')).toBe(true)
  })

  it('flags a labels key that is not a known LabelKey', () => {
    const vocabulary = resolveVocabulary({ labels: { notARealKey: 'x' } })
    expect(vocabulary.problems).toContainEqual({ kind: 'unknown-key', key: 'notARealKey' })
  })

  for (const bad of ['', '   ', 42] as const) {
    it(`flags an invalid override and falls back to the default: ${JSON.stringify(bad)}`, () => {
      const vocabulary = resolveVocabulary({ labels: { ready: bad } })
      expect(vocabulary.problems).toContainEqual({ kind: 'invalid-override', key: 'ready', value: bad })
      const ready = vocabulary.labels.find((l) => l.key === 'ready')
      expect(ready?.name).toBe('ready')
      expect(ready?.source).toBe('default')
    })
  }

  it('flags a collision when two keys resolve to the same name', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'shared', blocked: 'shared' } })
    const collision = vocabulary.problems.find((p) => p.kind === 'collision')
    expect(collision).toBeDefined()
    if (collision?.kind === 'collision') {
      expect(collision.name).toBe('shared')
      expect([...collision.keys].sort()).toEqual(['blocked', 'ready'])
    }
  })
})

describe('verifyVocabulary', () => {
  it('reports a configured name absent from the repository as partial, in missing (acceptance case 3)', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'todo' } })
    const repoLabels: RepoLabels = {
      ok: true,
      names: vocabulary.labels.filter((l) => l.key !== 'ready').map((l) => l.name),
    }
    const report = verifyVocabulary(vocabulary, repoLabels)
    expect(report.verdict).toBe('partial')
    expect(report.missing).toContain('todo')
  })

  it('reports verified when every enabled name is present', () => {
    const vocabulary = resolveVocabulary({ labels: {} })
    const repoLabels: RepoLabels = { ok: true, names: vocabulary.labels.map((l) => l.name) }
    const report = verifyVocabulary(vocabulary, repoLabels)
    expect(report.verdict).toBe('verified')
    expect(report.missing).toEqual([])
  })

  it('reports mis-resolved on zero overlap', () => {
    const vocabulary = resolveVocabulary({ labels: {} })
    const repoLabels: RepoLabels = { ok: true, names: ['completely-unrelated'] }
    const report = verifyVocabulary(vocabulary, repoLabels)
    expect(report.verdict).toBe('mis-resolved')
  })

  it('reports unverified on a failed fetch, carrying the reason', () => {
    const vocabulary = resolveVocabulary({ labels: {} })
    const repoLabels: RepoLabels = { ok: false, reason: 'gh label list failed' }
    const report = verifyVocabulary(vocabulary, repoLabels)
    expect(report.verdict).toBe('unverified')
    expect(report.unverifiedReason).toBe('gh label list failed')
    expect(report.present).toEqual([])
    expect(report.missing).toEqual([])
  })

  it('reports a case-only difference as present, with a case-mismatch problem', () => {
    const vocabulary = resolveVocabulary({ labels: {} })
    const repoLabels: RepoLabels = {
      ok: true,
      names: vocabulary.labels.map((l) => l.name.toUpperCase()),
    }
    const report = verifyVocabulary(vocabulary, repoLabels)
    expect(report.missing).toEqual([])
    expect(report.present.length).toBe(vocabulary.labels.length)
    expect(report.problems.some((p) => p.kind === 'case-mismatch')).toBe(true)
  })
})

describe('labelName', () => {
  it('returns undefined for a module-disabled key', () => {
    const vocabulary = resolveVocabulary({ labels: {}, modules: { previewDatabase: false } })
    expect(labelName(vocabulary, 'refreshBranch')).toBeUndefined()
  })

  it('returns the resolved name for an enabled key', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'todo' } })
    expect(labelName(vocabulary, 'ready')).toBe('todo')
  })
})
