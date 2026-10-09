import { describe, expect, it } from 'vitest'
import { controlsBarState, effortOptions, modelOptions, nextMode } from './controls-model'
import type { SessionModels } from '../../../shared/hosting/controls'

const READY: SessionModels = {
  kind: 'ready',
  models: [
    { value: 'opus', displayName: 'Opus', description: '', efforts: ['low', 'high'] },
    { value: 'sonnet', displayName: 'Sonnet', description: '', efforts: [] },
  ],
}

describe('nextMode', () => {
  it('cycles default -> acceptEdits -> plan -> default', () => {
    expect(nextMode('default')).toBe('acceptEdits')
    expect(nextMode('acceptEdits')).toBe('plan')
    expect(nextMode('plan')).toBe('default')
  })
})

describe('modelOptions', () => {
  it('is empty while models are pending or unavailable', () => {
    expect(modelOptions({ kind: 'pending' }, null)).toEqual([])
    expect(modelOptions({ kind: 'unavailable', message: 'x' }, null)).toEqual([])
  })

  it('offers a leading Default option only when the current model is null', () => {
    expect(modelOptions(READY, null)).toEqual([{ value: '__default__', label: 'Default' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }])
    expect(modelOptions(READY, 'opus')).toEqual([{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }])
  })
})

describe('effortOptions', () => {
  it('is empty when the model is null or lists no efforts', () => {
    expect(effortOptions(READY, null)).toEqual([])
    expect(effortOptions(READY, 'sonnet')).toEqual([])
  })

  it('lists the chosen model own efforts', () => {
    expect(effortOptions(READY, 'opus')).toEqual(['low', 'high'])
  })
})

describe('controlsBarState', () => {
  it('reports pending/unavailable models distinctly from an empty ready list', () => {
    expect(controlsBarState({ permissionMode: 'default', model: null, effort: null }, { kind: 'pending' }).modelsPending).toBe(true)
    expect(controlsBarState({ permissionMode: 'default', model: null, effort: null }, { kind: 'unavailable', message: 'nope' }).modelsUnavailable).toBe('nope')
  })

  it('labels the mode, model, and effort for display', () => {
    const state = controlsBarState({ permissionMode: 'acceptEdits', model: 'opus', effort: 'high' }, READY)
    expect(state.mode).toEqual({ value: 'acceptEdits', label: 'Accept edits' })
    expect(state.modelLabel).toBe('Opus')
    expect(state.effortLabel).toBe('High')
  })
})
