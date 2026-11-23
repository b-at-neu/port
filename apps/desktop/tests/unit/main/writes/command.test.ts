import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { buildCommand, resolveKeys } from '@/main/writes/command'

const base = { kind: 'issue', number: 42, repo: 'o/r', addNames: [], removeNames: [], addAssignees: [], removeAssignees: [] } as const

describe('buildCommand', () => {
  it('builds an issue edit argv with add/remove labels and assignees', () => {
    const argv = buildCommand({ ...base, addNames: ['ready'], removeNames: ['blocked'], addAssignees: ['alice'], removeAssignees: ['bob'] })
    expect(argv).toEqual(['issue', 'edit', '42', '--repo', 'o/r', '--add-label', 'ready', '--remove-label', 'blocked', '--add-assignee', 'alice', '--remove-assignee', 'bob'])
  })

  it('uses pr as the subcommand for a pull request', () => {
    expect(buildCommand({ ...base, kind: 'pull-request', addNames: ['approved'] })[0]).toBe('pr')
  })
})

describe('resolveKeys', () => {
  it('names every resolved key and reports every unresolvable one rather than the first', () => {
    expect(resolveKeys(resolveVocabulary({}), ['ready', 'blocked'])).toEqual({ names: ['ready', 'blocked'], unresolved: [] })
    expect(resolveKeys({ labels: [], disabled: [], problems: [] }, ['ready', 'blocked'])).toEqual({ names: [], unresolved: ['ready', 'blocked'] })
  })
})
