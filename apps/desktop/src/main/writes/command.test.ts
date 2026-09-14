import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { LabelWriteRequest } from '../../shared/writes/types'
import { buildCommand } from './command'

const VOCABULARY: LabelVocabulary = resolveVocabulary({})
const REPO_ID = 'repo-1' as unknown as RepoId

function request(overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest {
  return {
    repoId: REPO_ID,
    repo: 'o/r',
    kind: 'issue',
    number: 42,
    vocabulary: VOCABULARY,
    add: [],
    remove: [],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: [], absent: [], assignees: { kind: 'any' } },
    action: 'test',
    ...overrides,
  }
}

describe('buildCommand', () => {
  it('builds an issue edit argv with add/remove labels and assignees', () => {
    const result = buildCommand(request({ add: ['ready'], remove: ['blocked'], addAssignees: ['alice'], removeAssignees: ['bob'] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.argv).toEqual(['issue', 'edit', '42', '--repo', 'o/r', '--add-label', 'ready', '--remove-label', 'blocked', '--add-assignee', 'alice', '--remove-assignee', 'bob'])
    expect(result.addNames).toEqual(['ready'])
    expect(result.removeNames).toEqual(['blocked'])
  })

  it('uses pr as the subcommand for a pull request', () => {
    const result = buildCommand(request({ kind: 'pull-request', add: ['approved'] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.argv[0]).toBe('pr')
  })

  it('reports every unresolvable key rather than the first', () => {
    const badVocabulary: LabelVocabulary = { labels: [], disabled: [], problems: [] }
    const result = buildCommand(request({ vocabulary: badVocabulary, add: ['ready'], remove: ['blocked'] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.unresolved).toEqual(['ready', 'blocked'])
  })
})
