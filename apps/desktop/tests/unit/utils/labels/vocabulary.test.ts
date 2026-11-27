import { describe, expect, it } from 'vitest'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { verifyVocabulary, type RepoLabels } from '@/utils/labels/vocabulary'

describe('verifyVocabulary', () => {
  it('reports a configured name absent from the repository as partial, in missing', () => {
    const vocabulary = resolveDisplayVocabulary({ states: { planning: 'todo' } })
    const repoLabels: RepoLabels = { ok: true, names: vocabulary.labels.filter((l) => l.key !== 'planning').map((l) => l.name) }
    const report = verifyVocabulary(vocabulary, repoLabels)
    expect(report.verdict).toBe('partial')
    expect(report.missing).toContain('todo')
  })

  it('reports verified when every name is present', () => {
    const vocabulary = resolveDisplayVocabulary({})
    const report = verifyVocabulary(vocabulary, { ok: true, names: vocabulary.labels.map((l) => l.name) })
    expect(report.verdict).toBe('verified')
    expect(report.missing).toEqual([])
  })

  it('reports mis-resolved on zero overlap', () => {
    const report = verifyVocabulary(resolveDisplayVocabulary({}), { ok: true, names: ['completely-unrelated'] })
    expect(report.verdict).toBe('mis-resolved')
  })

  it('reports unverified on a failed fetch, carrying the reason', () => {
    const report = verifyVocabulary(resolveDisplayVocabulary({}), { ok: false, reason: 'gh label list failed' })
    expect(report.verdict).toBe('unverified')
    expect(report.unverifiedReason).toBe('gh label list failed')
    expect(report.present).toEqual([])
    expect(report.missing).toEqual([])
  })

  it('reports a case-only difference as present, with a case-mismatch problem', () => {
    const vocabulary = resolveDisplayVocabulary({})
    const report = verifyVocabulary(vocabulary, { ok: true, names: vocabulary.labels.map((l) => l.name.toUpperCase()) })
    expect(report.missing).toEqual([])
    expect(report.present).toHaveLength(vocabulary.labels.length)
    expect(report.problems.some((p) => p.kind === 'case-mismatch')).toBe(true)
  })
})
