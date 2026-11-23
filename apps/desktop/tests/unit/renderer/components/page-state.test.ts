import { describe, expect, it } from 'vitest'
import { pageState } from '@/renderer/components/page-state'

const isEmpty = (rows: readonly number[]) => rows.length === 0

describe('pageState', () => {
  it.each([
    ['pending', undefined, 'loading'],
    ['error', undefined, 'error'],
    ['error', [1], 'ready'],
    ['error', [], 'empty'],
    ['success', [], 'empty'],
    ['success', [1], 'ready'],
  ] as const)('%s with data %j is %s', (status, data, expected) => {
    expect(pageState({ status, data }, isEmpty)).toBe(expected)
  })
})
