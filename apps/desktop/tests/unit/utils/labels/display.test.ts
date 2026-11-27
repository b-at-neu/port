import { describe, expect, it } from 'vitest'
import template from '@/utils/labels/labels.json'
import { DISPLAY_DEFAULTS, DISPLAY_KEYS, mirrorVocabularyOf, resolveDisplayVocabulary } from '@/utils/labels/display'
import { verifyVocabulary } from '@/utils/labels/vocabulary'

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

describe('mirrorVocabularyOf', () => {
  const displayVocabulary = resolveDisplayVocabulary({})

  it('mirrors the configured display labels', () => {
    const custom = resolveDisplayVocabulary({ states: { planning: 'thinking' } })
    expect(mirrorVocabularyOf({ displayVocabulary })).toEqual({ kind: 'display', labels: displayVocabulary })
    expect(mirrorVocabularyOf({ displayVocabulary: custom }).labels).toBe(custom)
  })
})
