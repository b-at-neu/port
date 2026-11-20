import { describe, expect, it } from 'vitest'
import template from '@/utils/labels/labels.json'
import { DISPLAY_DEFAULTS, DISPLAY_KEYS, resolveDisplayVocabulary, verifiableVocabularyOf } from '@/utils/labels/display'
import { resolveVocabulary, verifyVocabulary } from '@/utils/labels/vocabulary'

describe('DISPLAY_KEYS / DISPLAY_DEFAULTS match the shipped display template', () => {
  it('carries every template key, both directions', () => {
    expect([...DISPLAY_KEYS].sort()).toEqual(template.labels.map((l) => l.key).sort())
    expect(DISPLAY_DEFAULTS).toHaveLength(template.labels.length)
  })
})

describe('resolveDisplayVocabulary', () => {
  it('resolves the seven defaults with no problems', () => {
    const resolved = resolveDisplayVocabulary({})
    expect(resolved.labels.map((l) => l.name)).toEqual(['port', 'needs you', 'planning', 'implementing', 'reviewing', 'revising', 'approved'])
    expect(resolved.labels.every((l) => l.source === 'default')).toBe(true)
    expect(resolved.problems).toEqual([])
  })

  it('applies a config override verbatim, keeping its casing', () => {
    const resolved = resolveDisplayVocabulary({ labels: { needsYou: 'Needs Attention' }, states: { implementing: 'Building' } })
    expect(resolved.labels.find((l) => l.key === 'needsYou')).toMatchObject({ name: 'Needs Attention', source: 'config' })
    expect(resolved.labels.find((l) => l.key === 'implementing')).toMatchObject({ name: 'Building', source: 'config' })
  })

  it('lets a CLAUDE.md override win over config', () => {
    const resolved = resolveDisplayVocabulary({ states: { approved: 'ok' }, overrides: { approved: 'shipped' } })
    expect(resolved.labels.find((l) => l.key === 'approved')).toMatchObject({ name: 'shipped', source: 'CLAUDE.md' })
  })

  it('reports an unknown key in either map, and a state key under labels', () => {
    const resolved = resolveDisplayVocabulary({ labels: { ready: 'x', planning: 'y' }, states: { inProgress: 'z' } })
    expect(resolved.problems).toEqual([
      { kind: 'unknown-key', key: 'ready' },
      { kind: 'unknown-key', key: 'planning' },
      { kind: 'unknown-key', key: 'states.inProgress' },
    ])
  })

  it('reports a blank override and falls back to the default', () => {
    const resolved = resolveDisplayVocabulary({ states: { planning: '  ' } })
    expect(resolved.problems).toEqual([{ kind: 'invalid-override', key: 'planning', value: '  ' }])
    expect(resolved.labels.find((l) => l.key === 'planning')?.name).toBe('planning')
  })

  it('reports two keys resolving to one name, case-insensitively', () => {
    const resolved = resolveDisplayVocabulary({ states: { planning: 'Work', implementing: 'work' } })
    expect(resolved.problems).toContainEqual({ kind: 'collision', name: 'work', keys: ['planning', 'implementing'] })
  })
})

describe('verifying the display vocabulary against a repository', () => {
  it('is verified when all seven labels exist, whatever their casing', () => {
    const report = verifyVocabulary(resolveDisplayVocabulary({}), { ok: true, names: ['Port', 'Needs You', 'planning', 'implementing', 'reviewing', 'revising', 'approved'] })
    expect(report.verdict).toBe('verified')
    expect(report.problems.map((p) => p.kind)).toEqual(['case-mismatch', 'case-mismatch'])
  })

  it('reports the labels a legacy repository lacks as missing', () => {
    const report = verifyVocabulary(resolveDisplayVocabulary({}), { ok: true, names: ['claude', 'planning', 'reviewing'] })
    expect(report.verdict).toBe('partial')
    expect(report.missing).toEqual(['port', 'needs you', 'implementing', 'revising', 'approved'])
  })
})

describe('verifiableVocabularyOf', () => {
  const vocabulary = resolveVocabulary({})
  const displayVocabulary = resolveDisplayVocabulary({})

  it('reads the display vocabulary only when app-only', () => {
    expect(verifiableVocabularyOf({ appOnly: true, vocabulary, displayVocabulary })).toBe(displayVocabulary)
    expect(verifiableVocabularyOf({ appOnly: false, vocabulary, displayVocabulary })).toBe(vocabulary)
  })

  it('reads the legacy vocabulary when appOnly or the display vocabulary is absent', () => {
    expect(verifiableVocabularyOf({ vocabulary })).toBe(vocabulary)
    expect(verifiableVocabularyOf({ appOnly: true, vocabulary })).toBe(vocabulary)
  })
})
