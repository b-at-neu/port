import { describe, expect, it } from 'vitest'
import { toolDetailFor } from './tool-detail'

describe('toolDetailFor', () => {
  it('reads a numeric exitCode off toolUseResult', () => {
    const detail = toolDetailFor('Bash', { command: 'ls' }, null, { exitCode: 2 }, true)
    expect(detail).toEqual({ kind: 'bash', command: 'ls', exitCode: 2, interrupted: false })
  })

  it('falls back to an Exit code line in an error result', () => {
    const detail = toolDetailFor('Bash', { command: 'false' }, { content: 'Exit code 1\nboom' }, null, true)
    expect(detail).toEqual({ kind: 'bash', command: 'false', exitCode: 1, interrupted: false })
  })

  it('never shows an unknown exit code as 0', () => {
    const detail = toolDetailFor('Bash', { command: 'sleep 1' }, null, null, false)
    expect(detail).toEqual({ kind: 'bash', command: 'sleep 1', exitCode: null, interrupted: false })
  })

  it('drops a todo with an unrecognised status and counts it', () => {
    const detail = toolDetailFor(
      'TodoWrite',
      { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'bogus' }, 'not-a-record'] },
      null,
      null,
      false,
    )
    expect(detail).toEqual({ kind: 'todos', items: [{ content: 'a', status: 'completed' }], droppedCount: 2 })
  })

  it('reads a Task/Agent description and subagent type', () => {
    const detail = toolDetailFor('Task', { description: 'read files', subagent_type: 'general' }, null, null, false)
    expect(detail).toEqual({ kind: 'task', description: 'read files', subagentType: 'general' })
  })

  it('counts non-empty lines for Read, null until a result arrives', () => {
    expect(toolDetailFor('Read', {}, null, null, false)).toEqual({ kind: 'lookup', count: null })
    expect(toolDetailFor('Read', {}, 'a\nb\nc\n', null, true)).toEqual({ kind: 'lookup', count: 3 })
  })

  it('reads a leading "No " result as a zero count', () => {
    expect(toolDetailFor('Grep', {}, 'No matches found', null, true)).toEqual({ kind: 'lookup', count: 0 })
  })

  it('returns null for a tool with no dedicated card', () => {
    expect(toolDetailFor('Edit', {}, null, null, true)).toBeNull()
  })
})
