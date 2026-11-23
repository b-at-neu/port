import { describe, expect, it } from 'vitest'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { ROUTE_KEYS } from '../../visual/targets.mjs'

describe('visual ROUTE_KEYS', () => {
  it('names exactly the router ROUTE_IDS keys, both directions', () => {
    expect([...ROUTE_KEYS].sort()).toEqual(Object.keys(ROUTE_IDS).sort())
  })
})
