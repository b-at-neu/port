import { describe, expect, it } from 'vitest'
import { withDenial, withoutDenialId, withoutDenialRule } from './attention'
import type { StageDenial } from '../../shared/stage/types'
import type { RepoId } from '../../shared/repos'

function denial(overrides: Partial<StageDenial> = {}): StageDenial {
  return { id: 'd1', repoId: 'repo1' as RepoId, agent: 'impl', number: 1, toolName: 'Bash', inputSummary: 'git push', rule: 'Bash(git push *)', at: '2026-01-01T00:00:00.000Z', ...overrides }
}

describe('withDenial', () => {
  it('a repeated denial for the same rule replaces the old one', () => {
    const result = withDenial([denial({ id: 'd1' })], denial({ id: 'd2' }))
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('d2')
  })

  it('bounds the list to 20, dropping the oldest', () => {
    const many = Array.from({ length: 20 }, (_, i) => denial({ id: `d${String(i)}`, rule: `Bash(x${String(i)} *)` }))
    const result = withDenial(many, denial({ id: 'd20', rule: 'Bash(x20 *)' }))
    expect(result).toHaveLength(20)
    expect(result.some((d) => d.id === 'd0')).toBe(false)
    expect(result.some((d) => d.id === 'd20')).toBe(true)
  })
})

describe('withoutDenialId / withoutDenialRule', () => {
  it('removes by id', () => {
    expect(withoutDenialId([denial({ id: 'd1' })], 'd1')).toEqual([])
  })

  it('removes by rule', () => {
    expect(withoutDenialRule([denial({ rule: 'Bash(x *)' })], 'Bash(x *)')).toEqual([])
  })
})
