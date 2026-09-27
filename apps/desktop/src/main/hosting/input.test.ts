import { describe, expect, it } from 'vitest'
import { createHostedInput } from './input'

async function next(input: ReturnType<typeof createHostedInput>) {
  const iterator = input.stream[Symbol.asyncIterator]()
  return iterator.next()
}

describe('createHostedInput', () => {
  it('a push before next() is queued and delivered in order', async () => {
    const input = createHostedInput()
    input.push('first')
    input.push('second')
    const iterator = input.stream[Symbol.asyncIterator]()
    const a = await iterator.next()
    const b = await iterator.next()
    expect(a.done).toBe(false)
    expect(b.done).toBe(false)
    if (a.done || b.done) throw new Error('unreachable')
    expect(a.value.message).toEqual({ role: 'user', content: 'first' })
    expect(b.value.message).toEqual({ role: 'user', content: 'second' })
  })

  it('a push after next() is already waiting resolves it directly', async () => {
    const input = createHostedInput()
    const pending = next(input)
    input.push('hello')
    const result = await pending
    expect(result.done).toBe(false)
    if (result.done) throw new Error('unreachable')
    expect(result.value.message).toEqual({ role: 'user', content: 'hello' })
  })

  it('each push stamps a distinct uuid, returned to the caller', () => {
    const input = createHostedInput()
    const a = input.push('one')
    const b = input.push('two')
    expect(a.uuid).not.toBe(b.uuid)
    expect(a.uuid.length).toBeGreaterThan(0)
  })

  it('end() closes the iterator for a next() already waiting', async () => {
    const input = createHostedInput()
    const pending = next(input)
    input.end()
    const result = await pending
    expect(result.done).toBe(true)
  })

  it('end() closes the iterator for a next() called afterward', async () => {
    const input = createHostedInput()
    input.end()
    const result = await next(input)
    expect(result.done).toBe(true)
  })

  it('a queued message still drains before end() takes effect', async () => {
    const input = createHostedInput()
    input.push('queued')
    input.end()
    const iterator = input.stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const second = await iterator.next()
    expect(second.done).toBe(true)
  })

  it('a second end() is a no-op, never a second resolution', () => {
    const input = createHostedInput()
    input.end()
    expect(() => input.end()).not.toThrow()
  })

  it('parent_tool_use_id is always null — this queue never addresses a subagent', async () => {
    const input = createHostedInput()
    input.push('hi')
    const result = await next(input)
    if (result.done) throw new Error('unreachable')
    expect(result.value.parent_tool_use_id).toBeNull()
  })
})
