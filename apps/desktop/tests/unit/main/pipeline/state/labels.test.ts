import { describe, expect, it } from 'vitest'
import { stateLabelsOf } from '@/main/pipeline/state/labels'
import type { PipelineView } from '@/types/pipeline-state'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { queuedAt, ticketAt } from '../../../../support/tickets'

const VOCABULARY = resolveDisplayVocabulary({})
const STORE: PipelineView = {
  kind: 'store',
  items: [{ kind: 'issue', number: 7, ticket: ticketAt('implement', queuedAt(), { ticket: 7 }) }],
}

describe('stateLabelsOf', () => {
  it('is null for an unseeded repository, which has no store to read', () => {
    expect(stateLabelsOf({ kind: 'unseeded' }, 'issue', 7, VOCABULARY)).toBeNull()
  })

  it('names the display labels the stored ticket shows, as configured', () => {
    expect(stateLabelsOf(STORE, 'issue', 7, VOCABULARY)).toEqual(['port', 'implementing'])
  })

  it('is empty for an untracked item, and does not confuse an issue with a pull request of the same number', () => {
    expect(stateLabelsOf(STORE, 'issue', 8, VOCABULARY)).toEqual([])
    expect(stateLabelsOf(STORE, 'pull-request', 7, VOCABULARY)).toEqual([])
  })

  it('follows a renamed label', () => {
    expect(stateLabelsOf(STORE, 'issue', 7, resolveDisplayVocabulary({ labels: { implementing: 'go' } }))).toContain('go')
  })
})
