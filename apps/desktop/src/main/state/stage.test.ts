import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import { stageOf } from './stage'

const VOCABULARY = resolveVocabulary({})

describe('stageOf', () => {
  it('resolves each role alone', () => {
    expect(stageOf(['ready'], VOCABULARY).stage).toBe('trigger')
    expect(stageOf(['inProgress'], VOCABULARY).stage).toBe('in-flight')
    expect(stageOf(['blocked'], VOCABULARY).stage).toBe('gate')
    expect(stageOf(['prOpened'], VOCABULARY).stage).toBe('terminal')
  })

  it('refreshing + approved resolves to the in-flight winner, both in stages, stageAmbiguous true', () => {
    const result = stageOf(['refreshing', 'approved'], VOCABULARY)
    expect(result.stage).toBe('in-flight')
    expect(result.stageAmbiguous).toBe(true)
    expect(result.stages.map((s) => s.key).sort()).toEqual(['approved', 'refreshing'].sort())
  })

  it('blocked + ready resolves to the gate', () => {
    const result = stageOf(['blocked', 'ready'], VOCABULARY)
    expect(result.stage).toBe('gate')
    expect(result.stageAmbiguous).toBe(true)
  })

  it('markers only yield stage: null, and set marked/autoPlan', () => {
    const result = stageOf(['marker', 'autoPlan'], VOCABULARY)
    expect(result.stage).toBeNull()
    expect(result.stages).toEqual([])
    expect(result.marked).toBe(true)
    expect(result.autoPlan).toBe(true)
    expect(result.stageAmbiguous).toBe(false)
  })

  it('no labels at all yields stage: null and no markers', () => {
    const result = stageOf([], VOCABULARY)
    expect(result.stage).toBeNull()
    expect(result.marked).toBe(false)
    expect(result.autoPlan).toBe(false)
  })

  it('a module-disabled key never appears in stages', () => {
    const vocabulary = resolveVocabulary({ modules: {} })
    // No shipped label is module-gated (#189) — resolveVocabulary itself
    // never disables anything today. This asserts the skip behaviour holds
    // for any key the vocabulary genuinely does not resolve.
    const result = stageOf(['ready'], { ...vocabulary, labels: vocabulary.labels.filter((l) => l.key !== 'ready') })
    expect(result.stages).toEqual([])
    expect(result.stage).toBeNull()
  })
})
