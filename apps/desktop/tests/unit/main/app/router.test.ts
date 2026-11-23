import { describe, expect, it } from 'vitest'
import { actions } from '@/main/app/router'
import { callAction } from '../../../support/call-action'

const NAME_SHAPE = /^[a-z]+\.[a-zA-Z]+$/

describe('router', () => {
  it('names every action <feature>.<verb> and never repeats one', () => {
    const names = actions.map((action) => action.name)
    expect(names.filter((name) => !NAME_SHAPE.test(name))).toEqual([])
    expect(new Set(names).size).toBe(names.length)
  })

  it('rejects a malformed request for every action that takes a payload, before run', () => {
    const payloadActions = actions.filter((action) => action.input.safeParse(undefined).success === false)
    expect(payloadActions.length).toBeGreaterThan(0)
    for (const action of payloadActions) {
      expect(action.input.safeParse({ unexpected: true }).success, action.name).toBe(false)
      expect(action.input.safeParse(null).success, action.name).toBe(false)
    }
  })

  it('rejects a payload for every action that takes none', () => {
    for (const action of actions.filter((candidate) => candidate.input.safeParse(undefined).success && !candidate.input.safeParse({}).success)) {
      expect(action.input.safeParse({ unexpected: true }).success, action.name).toBe(false)
    }
  })

  it('fails the call, never reaches run, when the input does not parse', async () => {
    await expect(callAction({}, 'repos.remove', {} as never)).rejects.toThrow()
  })
})
