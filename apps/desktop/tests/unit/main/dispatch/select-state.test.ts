import { describe, expect, it } from 'vitest'
import { survived } from '@/main/dispatch/select'
import type { ResolvedItem } from '@/types/github'
import type { TickActionable } from '@/types/tick'
import { resolveVocabulary } from '@/utils/labels/vocabulary'

const VOCABULARY = resolveVocabulary({})
const CANDIDATE = { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null } as TickActionable

function resolved(labels: readonly string[], assignees: readonly string[] = ['op']): ResolvedItem {
  return { number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels, assignees, headRefName: null, author: null }
}

describe('survived — store labels', () => {
  it('reads the labels GitHub returned when the store has none to offer', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, VOCABULARY, 'op')).toBe(true)
    expect(survived(resolved([]), CANDIDATE, VOCABULARY, 'op')).toBe(false)
  })

  it('survives on the store\'s stage even when every label was removed on GitHub', () => {
    expect(survived(resolved([]), CANDIDATE, VOCABULARY, 'op', ['claude', 'plan approved'])).toBe(true)
  })

  it('does not survive a trigger the store no longer holds, even when GitHub still shows it', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, VOCABULARY, 'op', ['claude', 'in progress'])).toBe(false)
  })

  it('does not dispatch an item the store does not track, even when GitHub shows the trigger', () => {
    expect(survived(resolved(['claude', 'plan approved']), CANDIDATE, VOCABULARY, 'op', [])).toBe(false)
  })

  it('still takes the assignees from GitHub', () => {
    expect(survived(resolved([], ['someone-else']), CANDIDATE, VOCABULARY, 'op', ['plan approved'])).toBe(false)
  })
})
