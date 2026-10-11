import { describe, expect, it } from 'vitest'
import { initialState, isComplete, setOther, toAnswers, toggleOption } from './question-model'
import type { AskQuestion } from '../../../shared/hosting/controls'

const SINGLE: AskQuestion = { question: 'Which approach?', header: 'H', multiSelect: false, options: [{ label: 'A', description: null }, { label: 'B', description: null }] }
const MULTI: AskQuestion = { question: 'Which tests?', header: 'H', multiSelect: true, options: [{ label: 'Unit', description: null }, { label: 'E2E', description: null }, { label: 'Manual', description: null }] }

describe('toggleOption', () => {
  it('single-select replaces the prior selection', () => {
    let state = initialState([SINGLE])
    state = toggleOption(state, 0, false, 'A')
    state = toggleOption(state, 0, false, 'B')
    expect([...(state[0]?.selected ?? [])]).toEqual(['B'])
  })

  it('multi-select toggles membership', () => {
    let state = initialState([MULTI])
    state = toggleOption(state, 0, true, 'Unit')
    state = toggleOption(state, 0, true, 'E2E')
    expect([...(state[0]?.selected ?? [])].sort()).toEqual(['E2E', 'Unit'])
    state = toggleOption(state, 0, true, 'Unit')
    expect([...(state[0]?.selected ?? [])]).toEqual(['E2E'])
  })
})

describe('toAnswers', () => {
  it('single-select answers with the selected label', () => {
    let state = initialState([SINGLE])
    state = toggleOption(state, 0, false, 'B')
    expect(toAnswers([SINGLE], state)).toEqual({ 'Which approach?': 'B' })
  })

  it('multi-select joins labels in option order, not selection order', () => {
    let state = initialState([MULTI])
    state = toggleOption(state, 0, true, 'Manual')
    state = toggleOption(state, 0, true, 'Unit')
    expect(toAnswers([MULTI], state)).toEqual({ 'Which tests?': 'Unit, Manual' })
  })

  it('appends a trimmed Other to the joined labels', () => {
    let state = initialState([MULTI])
    state = toggleOption(state, 0, true, 'Unit')
    state = setOther(state, 0, '  Load testing  ')
    expect(toAnswers([MULTI], state)).toEqual({ 'Which tests?': 'Unit, Load testing' })
  })

  it('Other alone answers without a leading comma', () => {
    let state = initialState([SINGLE])
    state = setOther(state, 0, 'Something else')
    expect(toAnswers([SINGLE], state)).toEqual({ 'Which approach?': 'Something else' })
  })
})

describe('isComplete', () => {
  it('is false until every question has a non-empty answer', () => {
    let state = initialState([SINGLE, MULTI])
    expect(isComplete([SINGLE, MULTI], state)).toBe(false)
    state = toggleOption(state, 0, false, 'A')
    expect(isComplete([SINGLE, MULTI], state)).toBe(false)
    state = toggleOption(state, 1, true, 'Unit')
    expect(isComplete([SINGLE, MULTI], state)).toBe(true)
  })
})
